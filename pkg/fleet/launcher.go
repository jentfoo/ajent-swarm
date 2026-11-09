package fleet

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/go-analyze/bulk"
	"github.com/jentfoo/ajent/pkg/ctl"
)

// resumePathSuffix targets ajent resolves by transcript path inside the
// workspace, which the cross-workspace listing never carries.
const resumePathSuffix = ".jsonl"

// Launch and stop tuning. The launch window must cover a resuming child
// replaying a large transcript before it serves.
const (
	launchWaitDefault = 30 * time.Second
	exitGraceDefault  = 10 * time.Second // /exit settles before SIGTERM
	termGraceDefault  = 5 * time.Second  // SIGTERM before SIGKILL
	killGrace         = 3 * time.Second

	stopPollEvery = 25 * time.Millisecond

	stopLine  = "/exit"
	logSuffix = ".log"
	dirPerm   = 0o700

	tailLimit = 8 << 10 // failure hints kept in the child record
)

// awaitPollEvery is the default registry poll cadence while awaiting a
// launched child; Options.AwaitPoll overrides it.
const awaitPollEvery = 250 * time.Millisecond

// childProc tracks one ajent process swarm spawned: its record, its command
// while it runs, and an exit channel closed once the process is reaped and
// recorded. Adopted orphans carry no waitable command; their death is judged
// by pid.
type childProc struct {
	rec      ChildRecord
	cmd      *exec.Cmd // nil for adopted orphans
	adopted  bool      // re-adopted across a restart
	stopping bool      // a stop is in flight, so the death is swarm's doing
	empty    bool      // the run proved empty: served and observed no activity
	exit     chan struct{}
}

// reaped reports whether the child's exit was recorded.
func reaped(cp *childProc) bool {
	if cp == nil {
		return false
	}
	select {
	case <-cp.exit:
		return true
	default:
		return false
	}
}

// Launch spawns one headless ajent session as a child of the service and
// waits, bounded, for its control socket to appear. The child joins its own
// process group so it outlives the service; the registry record it writes
// hands it to the manager for dialing. Nothing after the spawn depends on
// ctx: bookkeeping always completes, so a child never launches half-known.
func (m *Manager) Launch(ctx context.Context, req LaunchRequest) (LaunchResult, error) {
	if !spawnSupported() {
		return LaunchResult{}, errNoSpawn
	}
	norm := req.normalized()
	if err := norm.validate(); err != nil {
		return LaunchResult{}, err
	}
	// a resume target must name a recorded transcript before anything spawns:
	// ajent resolves it against the workspace alone, and a sighting of a session
	// whose recording was dropped on exit would fail the child after the fact.
	if norm.Mode == LaunchResume && !strings.HasSuffix(norm.Target, resumePathSuffix) {
		if _, err := m.savedRow(norm.Target); errors.Is(err, ErrUnknownSaved) {
			return LaunchResult{}, err
		}
	}
	if m.ctx == nil {
		return LaunchResult{}, errors.New("manager is not started")
	}
	if m.bin == "" || m.childrenDir == "" {
		return LaunchResult{}, errors.New("launching is not configured; pass --ajent-bin")
	}
	if err := os.MkdirAll(m.childrenDir, dirPerm); err != nil {
		return LaunchResult{}, fmt.Errorf("children dir: %w", err)
	}

	m.mu.Lock()
	cp, err := m.spawnLocked(norm)
	m.mu.Unlock()
	if err != nil {
		return LaunchResult{}, err
	}
	go m.reapChild(cp)

	actx, cancel := context.WithTimeout(context.WithoutCancel(ctx), m.launchWait)
	defer cancel()
	sid, err := m.awaitSocket(actx, cp)
	if err != nil {
		return LaunchResult{}, fmt.Errorf("launch in %s: %w", norm.Workspace, err)
	}
	m.finishLaunch(cp, sid)
	m.log.Info("child serving", "pid", cp.rec.PID, "session", sid, "workspace", norm.Workspace)

	m.mu.Lock()
	res := LaunchResult{
		SessionID: sid,
		PID:       cp.rec.PID,
		Workspace: cp.rec.Workspace,
		LogPath:   cp.rec.LogPath,
	}
	m.mu.Unlock()
	return res, nil
}

// spawnLocked starts the child process and registers it, holding the manager
// lock so the registry watch cannot discover it between start and
// registration. Everything here binds the manager's store context: the
// child and its records outlive this request and the service itself.
// mu must be held.
func (m *Manager) spawnLocked(req LaunchRequest) (*childProc, error) {
	logf, err := os.CreateTemp(m.childrenDir, "spawn-*"+logSuffix)
	if err != nil {
		return nil, fmt.Errorf("child log: %w", err)
	}
	argv := req.argv(m.bin)
	cmd := exec.CommandContext(m.storeCtx, argv[0], argv[1:]...)
	cmd.Dir = req.Workspace
	cmd.Stdout, cmd.Stderr = logf, logf
	cmd.SysProcAttr = procAttrs()
	if err := cmd.Start(); err != nil {
		_ = logf.Close()
		_ = os.Remove(logf.Name())
		return nil, fmt.Errorf("spawn ajent: %w", err)
	}
	// the child holds its inherited fd from here, so the parent's copy can
	// close once the log moved to the child's pid name
	path := filepath.Join(m.childrenDir, strconv.Itoa(cmd.Process.Pid)+logSuffix)
	if err := os.Rename(logf.Name(), path); err != nil {
		path = logf.Name()
	}
	_ = logf.Close()

	rec := ChildRecord{
		PID:       cmd.Process.Pid,
		Workspace: req.Workspace,
		Argv:      req.summary(),
		LogPath:   path,
		StartedAt: time.Now(),
	}
	if m.childStore != nil {
		id, err := m.childStore.CreateChild(m.storeCtx, rec)
		if err != nil {
			m.log.Warn("child record not persisted", "pid", rec.PID, "err", err)
		}
		rec.ID = id
	}
	cp := &childProc{rec: rec, cmd: cmd, exit: make(chan struct{})}
	m.children[rec.PID] = cp
	return cp, nil
}

// reapChild waits the child out and records its exit, publishing the reaped
// status to the session's viewers. A run its actor proves empty drops its row
// instead: upstream retention keeps only sessions that did something. Runs
// once per spawn, detached: children outlive swarm, so nothing waits on this
// goroutine.
func (m *Manager) reapChild(cp *childProc) {
	_ = cp.cmd.Wait()
	note := "exited"
	var code int
	if ps := cp.cmd.ProcessState; ps != nil {
		code = ps.ExitCode()
		note = ps.String()
	} else {
		code = -1
	}

	m.mu.Lock()
	path := cp.rec.LogPath
	m.mu.Unlock()
	tail := readTail(path, tailLimit)

	m.mu.Lock()
	cp.rec.ExitedAt = time.Now()
	cp.rec.ExitCode = &code
	cp.rec.ExitNote = note
	cp.rec.LogTail = tail
	rec := cp.rec
	m.mu.Unlock()

	m.settleChild(cp, rec)
	if rec.SessionID != "" {
		m.publishChildEvent(rec.SessionID, ChildFrame{
			Type: FrameChild, SessionID: rec.SessionID, State: ChildExited, Detail: note,
		})
	}
	m.log.Info("child reaped", "pid", rec.PID, "session", rec.SessionID, "status", note)
	close(cp.exit)
}

// settleChild finishes one ended child's row: a run its actor proves empty
// drops everywhere, anything else persists the recorded exit facts.
func (m *Manager) settleChild(cp *childProc, rec ChildRecord) {
	if m.emptyRun(cp) && m.dropChild(rec) {
		return
	}
	m.persistChild(rec)
}

// markEmptyRunLocked stamps one spawned child's run as proven empty, keyed by
// pid so a relaunched session's rows never bleed together. mu must be held.
func (m *Manager) markEmptyRunLocked(pid int) {
	if cp, ok := m.children[pid]; ok {
		cp.empty = true
	}
}

// emptyRun reports whether one run provably ended empty, the shape ajent
// deletes at exit: its actor stamped the run, or the actor table still
// carries the run's serving facts. Anything unproven, like a row adopted
// with no view facts, keeps its slot.
func (m *Manager) emptyRun(cp *childProc) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if cp.empty {
		return true
	}
	for _, a := range m.actors {
		if st := a.status.Load(); st.PID == cp.rec.PID && st.SessionID == cp.rec.SessionID {
			return st.emptyRun()
		}
	}
	return false
}

// dropChild removes one ended run's row everywhere it is retained, so a
// session whose transcript ajent deleted never lists or resumes again. The
// store row goes first: a failed delete keeps every in-memory row.
func (m *Manager) dropChild(rec ChildRecord) bool {
	if rec.ID != 0 && m.childStore != nil {
		if err := m.childStore.DeleteChild(m.storeCtx, rec.ID); err != nil {
			m.log.Warn("empty ended session not removed", "pid", rec.PID, "err", err)
			return false
		}
	}
	m.mu.Lock()
	delete(m.children, rec.PID)
	delete(m.externals, rec.PID)
	if cur, ok := m.childBySession[rec.SessionID]; ok && cur.rec.PID == rec.PID {
		delete(m.childBySession, rec.SessionID)
	}
	m.mu.Unlock()
	m.log.Info("removed empty ended session", "pid", rec.PID, "session", rec.SessionID)
	return true
}

// awaitSocket polls discovery until the child's registry record appears and
// returns the session id it registered under. A child that dies first fails
// the launch with its log tail attached, so ajent's own hint surfaces.
func (m *Manager) awaitSocket(ctx context.Context, cp *childProc) (string, error) {
	tick := time.NewTicker(m.awaitPoll)
	defer tick.Stop()
	for {
		live, err := m.discover()
		if err != nil {
			m.log.Debug("discovery while awaiting child failed", "err", err)
		} else {
			if i := slices.IndexFunc(live, func(in ctl.Instance) bool {
				return in.PID == cp.rec.PID && in.SessionID != ""
			}); i >= 0 {
				return live[i].SessionID, nil
			}
		}
		select {
		case <-cp.exit:
			return "", fmt.Errorf("child exited before serving (%s); log tail:\n%s",
				cp.rec.ExitNote, cp.rec.LogTail)
		case <-ctx.Done():
			if reaped(cp) { // the exit may have landed beside the deadline
				return "", fmt.Errorf("child exited before serving (%s); log tail:\n%s",
					cp.rec.ExitNote, cp.rec.LogTail)
			}
			return "", fmt.Errorf("child did not register within %s; it is still running "+
				"and joins the fleet when it serves", m.launchWait)
		case <-tick.C:
		}
	}
}

// finishLaunch binds the launched pid to its session: the log moves to a
// name carrying the session id, the record persists it, and the registry
// watch wakes so the manager attaches without waiting out its tick.
func (m *Manager) finishLaunch(cp *childProc, sessionID string) {
	m.mu.Lock()
	cp.rec.SessionID = sessionID
	m.childBySession[sessionID] = cp
	old := cp.rec.LogPath
	m.mu.Unlock()

	renamed := filepath.Join(m.childrenDir,
		sessionID+"-"+strconv.Itoa(cp.rec.PID)+logSuffix)
	moved := os.Rename(old, renamed) == nil

	m.mu.Lock()
	if moved {
		cp.rec.LogPath = renamed
	}
	rec := cp.rec
	m.mu.Unlock()

	m.persistChild(rec)
	select { // wake the watch so the fresh child attaches without the tick
	case m.nudge <- struct{}{}:
	default:
	}
}

// persistChild writes a child record through to the store, best effort.
func (m *Manager) persistChild(rec ChildRecord) {
	if m.childStore == nil || rec.ID == 0 {
		return
	}
	if err := m.childStore.UpdateChild(m.storeCtx, rec); err != nil {
		m.log.Warn("child record not persisted", "pid", rec.PID, "err", err)
	}
}

// publishChildEvent fans one lifecycle frame out to a session's viewers.
func (m *Manager) publishChildEvent(sessionID string, frame ChildFrame) {
	if a := m.route(sessionID); a != nil {
		a.hub.publishChild(frame)
	}
}

// StopSession ends a session: /exit through the control connection first,
// then SIGTERM and SIGKILL for children swarm spawned; external sessions end
// through /exit alone, since swarm never signals a process it did not spawn.
// ctx bounds only the control calls. Stopping an already-exited session
// succeeds quietly; no other path tears children down (KillOnExit excepted).
func (m *Manager) StopSession(ctx context.Context, sessionID string) error {
	a := m.route(sessionID)
	pid := 0
	m.mu.Lock()
	cp := m.childBySession[sessionID]
	// a recorded exit counts only with the pid provably gone: a stale row
	// (an older run of a relaunched session) must never read as stopped while
	// the live process serves on. A live actor behind one is an external
	// resume of the transcript, not that child, so /exit alone applies.
	if cp != nil && !cp.rec.ExitedAt.IsZero() && pidGone(cp.rec.PID) {
		if a == nil {
			m.mu.Unlock()
			return nil
		}
		cp = nil
	}
	if cp != nil {
		pid = cp.rec.PID
		cp.stopping = true
	} else if a != nil {
		pid = a.status.Load().PID
	}
	m.mu.Unlock()
	if a == nil && cp == nil {
		return ErrUnknownSession
	}

	exited := false
	if a != nil {
		err := a.stopExit(ctx)
		var ce *ctl.Error
		if errors.As(err, &ce) {
			return err // a coded refusal reaches the caller: a held seat is never displaced
		}
		if err != nil {
			m.log.Warn("stop: /exit failed", "session", sessionID, "err", err)
		} else {
			exited = true
		}
	}

	if cp == nil {
		if !exited {
			return fmt.Errorf("session %s cannot be stopped: its control connection is down"+
				" and it is not a swarm child", sessionID)
		}
		if m.awaitEnded(a, nil, pid, m.exitGrace+m.termGrace) {
			return nil
		}
		return fmt.Errorf("session %s did not exit after %s; it is not a swarm child,"+
			" so no signal was sent", sessionID, stopLine)
	}

	grace := time.Duration(0) // no /exit landed: signals take over at once
	if exited {
		grace = m.exitGrace
	}
	if m.awaitEnded(a, cp, pid, grace) {
		m.markStopped(cp)
		return nil
	}
	m.log.Info("stop: sending SIGTERM", "session", sessionID, "pid", pid)
	_ = signalGroup(pid, syscall.SIGTERM)
	if m.awaitEnded(a, cp, pid, m.termGrace) {
		m.markStopped(cp)
		return nil
	}
	m.log.Info("stop: sending SIGKILL", "session", sessionID, "pid", pid)
	_ = signalGroup(pid, syscall.SIGKILL)
	if m.awaitEnded(a, cp, pid, killGrace) {
		m.markStopped(cp)
		return nil
	}
	return fmt.Errorf("child %d outlived SIGKILL", pid)
}

// awaitEnded polls for the end of a session: a reaped child, an actor that
// saw session.exit, or a pid that provably died for children without a
// waitable handle.
func (m *Manager) awaitEnded(a *sessionActor, cp *childProc, pid int, within time.Duration) bool {
	timer := time.NewTimer(within)
	defer timer.Stop()
	for {
		if reaped(cp) || ((cp == nil || cp.adopted) && pidGone(pid)) {
			return true
		}
		if a != nil && a.status.Load().State == ChildExited {
			return true
		}
		select {
		case <-timer.C:
			return false
		case <-time.After(stopPollEvery):
		}
	}
}

// markStopped records the exit of an adopted child, whose process swarm
// cannot wait on, dropping the row instead when its actor proves the run
// empty. Spawned children record their own exit in reapChild.
func (m *Manager) markStopped(cp *childProc) {
	if !cp.adopted {
		return
	}
	m.mu.Lock()
	if !cp.rec.ExitedAt.IsZero() {
		m.mu.Unlock()
		return
	}
	cp.rec.ExitedAt = time.Now()
	cp.rec.ExitNote = "stopped by swarm"
	rec := cp.rec
	m.mu.Unlock()
	m.settleChild(cp, rec)
}

// adopt loads persisted children at startup: running swarm children count as
// owned again so their seat is force-claimed when they serve, and ones whose
// pid is provably dead are marked exited. External rows only re-join the
// listing, with the same dead-pid marking.
func (m *Manager) adopt(ctx context.Context) {
	if m.childStore == nil {
		return
	}
	rows, err := m.childStore.Children(ctx)
	if err != nil {
		m.log.Warn("children re-adoption failed", "err", err)
		return
	}
	for _, rec := range rows {
		swarm := rec.spawnedBy() == SpawnedBySwarm
		running := rec.ExitedAt.IsZero()
		if running {
			if pidGone(rec.PID) {
				rec.ExitedAt = time.Now()
				rec.ExitNote = "not running when the service started"
				rec.LogTail = readTail(rec.LogPath, tailLimit)
				running = false
				m.persistChild(rec)
				m.log.Info("child lost across restart", "pid", rec.PID, "session", rec.SessionID)
			} else if swarm {
				m.log.Info("re-adopted child", "pid", rec.PID, "session", rec.SessionID)
			}
		}
		m.mu.Lock()
		if swarm {
			// indexed for the listing, stop lookups and the seat policy
			cp := &childProc{rec: rec, adopted: running, exit: make(chan struct{})}
			m.children[rec.PID] = cp
			if rec.SessionID != "" {
				// a relaunched session keeps one row per run: the live row must win
				// the session lookup or stop reads the dead row and quietly no-ops
				cur, ok := m.childBySession[rec.SessionID]
				if !ok || (running && !cur.rec.ExitedAt.IsZero()) {
					m.childBySession[rec.SessionID] = cp
				}
			}
		} else if _, ok := m.externals[rec.PID]; !ok {
			m.externals[rec.PID] = rec // retained for the listing alone
		}
		m.mu.Unlock()
	}
}

// reconcileAdopted marks re-adopted children exited once their pid provably
// died: no waitable handle exists, so only the watch notices. A run its actor
// proves empty drops its row instead. Called from the registry watch, whose
// cadence keeps this cheap.
func (m *Manager) reconcileAdopted() {
	m.mu.Lock()
	candidates := bulk.SliceFilter(func(cp *childProc) bool {
		// adopted cps have no reaper, so only the exited flag ends one
		return cp.adopted && cp.rec.ExitedAt.IsZero()
	}, bulk.MapValuesSlice(m.children))
	m.mu.Unlock()

	// the pid probe can block, so it stays outside the lock
	lost := bulk.SliceFilter(func(cp *childProc) bool { return pidGone(cp.rec.PID) }, candidates)

	for _, cp := range lost {
		m.mu.Lock()
		if !cp.rec.ExitedAt.IsZero() { // a concurrent stop may have marked it
			m.mu.Unlock()
			continue
		}
		cp.rec.ExitedAt = time.Now()
		cp.rec.ExitNote = "gone"
		if cp.stopping { // the stop path claims the attribution
			cp.rec.ExitNote = "stopped by swarm"
		}
		rec := cp.rec
		m.mu.Unlock()
		m.settleChild(cp, rec)
		if rec.SessionID != "" {
			m.publishChildEvent(rec.SessionID, ChildFrame{
				Type: FrameChild, SessionID: rec.SessionID, State: ChildExited, Detail: rec.ExitNote,
			})
		}
		m.log.Info("adopted child gone", "pid", rec.PID, "session", rec.SessionID)
	}
}

// killChildren terminates every running child; used only when the operator
// asked the service to take its children down on exit.
func (m *Manager) killChildren() {
	m.mu.Lock()
	targets := bulk.SliceFilterInPlace(func(pid int) bool {
		return m.children[pid].rec.ExitedAt.IsZero()
	}, bulk.MapKeysSlice(m.children))
	m.mu.Unlock()
	if len(targets) == 0 {
		return
	}
	m.log.Info("terminating children on shutdown", "count", len(targets))
	for _, pid := range targets {
		_ = signalGroup(pid, syscall.SIGTERM)
	}
	if !pidsGone(targets, m.termGrace) {
		for _, pid := range targets {
			_ = signalGroup(pid, syscall.SIGKILL)
		}
		pidsGone(targets, killGrace)
	}
}

// pidsGone waits until every pid stops answering, bounded.
func pidsGone(pids []int, within time.Duration) bool {
	deadline := time.NewTimer(within)
	defer deadline.Stop()
	for {
		pids = bulk.SliceFilter(func(pid int) bool { return !pidGone(pid) }, pids)
		if len(pids) == 0 {
			return true
		}
		select {
		case <-deadline.C:
			return false
		case <-time.After(stopPollEvery):
		}
	}
}

// readTail returns the last n bytes of a child log, for failure hints.
func readTail(path string, n int64) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer func() { _ = f.Close() }()
	if fi, err := f.Stat(); err == nil && fi.Size() > n {
		if _, err := f.Seek(-n, io.SeekEnd); err != nil {
			return ""
		}
	}
	buf, err := io.ReadAll(io.LimitReader(f, n))
	if err != nil {
		return ""
	}
	return strings.TrimLeft(string(buf), "\n")
}
