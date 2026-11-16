package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jentfoo/ajent-swarm/pkg/fleet"
	"github.com/jentfoo/ajent-swarm/pkg/sched"
	"github.com/jentfoo/ajent-swarm/pkg/store"
)

// maxRunLimit caps one history page.
const maxRunLimit = 1000

// Schedule preview bounds, the editor asks for three slots.
const (
	defaultPreviewSlots = 3
	maxPreviewSlots     = 50
)

// previewRequest is the POST /api/jobs/preview body: one draft job's fields,
// of which only the schedule (and an optional workspace check) matter, plus
// how many slots to compute.
type previewRequest struct {
	store.Job
	Count int `json:"count,omitempty"`
}

// schedulePreview answers a preview request: the next fires of the draft's
// schedule and what its workspace path check made of the filesystem.
type schedulePreview struct {
	Times          []time.Time `json:"times"`
	WorkspaceError string      `json:"workspaceError,omitempty"`
}

// handleJobPreview computes one draft schedule's next fires through the same
// evaluation code the trigger loop advances jobs with, so clients never
// duplicate scheduling semantics. Schedule problems answer 400, a workspace
// check reports in the reply, since an editor fixes one field at a time.
func (s *apiServer) handleJobPreview(w http.ResponseWriter, r *http.Request) {
	var req previewRequest
	if !readRequest(w, r, &req) {
		return
	}
	count := max(min(req.Count, maxPreviewSlots), 0)
	if count == 0 {
		count = defaultPreviewSlots
	}

	var wsErr string
	if ws := strings.TrimSpace(req.Workspace); ws != "" {
		if err := sched.CheckWorkspace(ws); err != nil {
			wsErr = err.Error()
		}
	}
	times, err := sched.PreviewTimes(req.Job, time.Now(), count)
	if err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, schedulePreview{Times: times, WorkspaceError: wsErr})
}

// jobRequest is the POST and PUT body for a job. Enabled rides separately so
// an omitted field keeps its current value instead of silently disabling.
type jobRequest struct {
	store.Job
	Enabled *bool `json:"enabled,omitempty"`
}

// applyEnabled resolves the request's enabled tri-state onto one job: an
// explicit value wins, otherwise create defaults on and update keeps what the
// stored row already says.
func (req jobRequest) applyEnabled(dst *store.Job, fallback bool) {
	switch {
	case req.Enabled != nil:
		dst.Enabled = *req.Enabled
	default:
		dst.Enabled = fallback
	}
}

// scheduleChanged reports whether anything that positions the next fire moved.
func scheduleChanged(a, b store.Job) bool {
	if a.ScheduleKind != b.ScheduleKind ||
		a.IntervalSeconds != b.IntervalSeconds ||
		a.DailyTime != b.DailyTime || a.TZ != b.TZ {
		return true
	}
	switch {
	case (a.NextRunAt == nil) != (b.NextRunAt == nil):
		return true
	case a.NextRunAt != nil:
		return !a.NextRunAt.Equal(*b.NextRunAt)
	default:
		return false
	}
}

// handleJobList serves every stored job. An empty list encodes [] not null,
// so list-shaped clients never trip on a missing array.
func (s *apiServer) handleJobList(w http.ResponseWriter, r *http.Request) {
	jobs, err := s.sched.Jobs(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, codeInternalError, "")
		return
	}
	writeJSON(w, http.StatusOK, orEmptySlice(jobs))
}

// handleJobCreate validates and stores one new job.
func (s *apiServer) handleJobCreate(w http.ResponseWriter, r *http.Request) {
	var req jobRequest
	if !readRequest(w, r, &req) {
		return
	}
	j := req.Job
	j.ID = 0
	j.CreatedAt = time.Now()
	j.Queued = false // queued rows come from the queue endpoint only
	req.applyEnabled(&j, true)

	if err := sched.ValidateJob(&j); err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, err.Error())
		return
	}

	next, err := nextRunFor(j, j.Enabled, j.NextRunAt == nil)
	if err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, err.Error())
		return
	}
	j.NextRunAt = next
	createJobReply(s, w, r, j)
}

// createJobReply stores one validated job and answers with the stored row.
func createJobReply(s *apiServer, w http.ResponseWriter, r *http.Request, j store.Job) {
	id, err := s.sched.CreateJob(r.Context(), j)
	switch {
	case errors.Is(err, store.ErrConflict):
		writeError(w, http.StatusConflict, codeConflict, err.Error())
	case err != nil:
		writeError(w, http.StatusInternalServerError, codeInternalError, "")
	default: // CreateJob nudged the trigger loop
		created, err := s.sched.JobByID(r.Context(), id)
		if err != nil {
			writeError(w, http.StatusInternalServerError, codeInternalError, "")
			return
		}
		writeJSON(w, http.StatusCreated, created)
	}
}

// writeJobError answers a job lookup error: unknown id as 404, anything else
// as 500. It reports whether a reply was written, so callers still owe the
// success body when it returns false.
func writeJobError(w http.ResponseWriter, err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, codeJobNotFound, "")
		return true
	}
	writeError(w, http.StatusInternalServerError, codeInternalError, "")
	return true
}

// handleJobGet serves one job by id.
func (s *apiServer) handleJobGet(w http.ResponseWriter, r *http.Request) {
	j, err := s.sched.JobByID(r.Context(), pathID(r))
	if writeJobError(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, j)
}

// handleJobUpdate replaces one job's fields. Schedule edits recompute the
// next fire, other edits keep it.
func (s *apiServer) handleJobUpdate(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	current, err := s.sched.JobByID(r.Context(), id)
	if writeJobError(w, err) {
		return
	}

	var req jobRequest
	if !readRequest(w, r, &req) {
		return
	}
	j := req.Job
	j.ID = current.ID
	j.CreatedAt = current.CreatedAt
	j.Queued = current.Queued // the marker is server-owned, like the row's id
	req.applyEnabled(&j, current.Enabled)
	// a queued row's slot is server-owned too: edits keep the queued-at
	// anchor, and re-enabling one whose slot already fired restarts the wait
	if j.Queued && j.NextRunAt == nil {
		switch {
		case current.NextRunAt != nil:
			j.NextRunAt = current.NextRunAt
		case j.Enabled:
			slot := time.Now()
			j.NextRunAt = &slot
		}
	}
	// a fired or disabled once row carries no slot, enabling one arms it a
	// fixed day out instead of refusing, so the list toggle stays one click
	if j.ScheduleKind == store.ScheduleOnce && j.Enabled && j.NextRunAt == nil {
		slot := sched.ReArmOnce(time.Now())
		j.NextRunAt = &slot
	}

	if err := sched.ValidateJob(&j); err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, err.Error())
		return
	}

	recompute := j.NextRunAt == nil || scheduleChanged(current, j)
	next, err := nextRunFor(j, j.Enabled, recompute)
	if err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, err.Error())
		return
	}
	j.NextRunAt = next

	switch err = s.sched.UpdateJob(r.Context(), j); {
	case err == nil:
		writeJSON(w, http.StatusOK, j)
	case errors.Is(err, store.ErrConflict):
		writeError(w, http.StatusConflict, codeConflict, err.Error())
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, codeJobNotFound, "")
	default:
		writeError(w, http.StatusInternalServerError, codeInternalError, "")
	}
}

// queueRequest is the POST /api/jobs/queue body: one prompt to park until the
// fleet is idle, plus the optional launch shaping it runs with. Name,
// workspace and prompt are required.
type queueRequest struct {
	Name           string `json:"name"`
	Workspace      string `json:"workspace"`
	Prompt         string `json:"prompt"`
	Model          string `json:"model,omitempty"`
	Permission     string `json:"permission,omitempty"`
	ToolsCustom    bool   `json:"toolsCustom,omitempty"`
	Tools          string `json:"tools,omitempty"`
	TriggerCommand string `json:"triggerCommand,omitempty"`
	TriggerOn      string `json:"triggerOn,omitempty"`
}

// handleJobQueue stores one queued prompt: a job that waits for an idle fleet,
// runs once in a fresh session and leaves that session open for review. The
// fixed shape is built here and pinned by validation, so the body carries
// only what the caller actually chooses.
func (s *apiServer) handleJobQueue(w http.ResponseWriter, r *http.Request) {
	var req queueRequest
	if !readRequest(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Prompt) == "" {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, "prompt is required")
		return
	}

	now := time.Now()
	j := store.Job{
		Name:           req.Name,
		Workspace:      req.Workspace,
		Prompt:         req.Prompt,
		SpawnMode:      string(fleet.LaunchNew),
		Model:          req.Model,
		Permission:     req.Permission,
		Tools:          req.Tools,
		ToolsCustom:    req.ToolsCustom,
		Enabled:        true,
		Queued:         true,
		ScheduleKind:   store.ScheduleOnce,
		NextRunAt:      &now, // due at once: the idle hold does the waiting
		KeepAlive:      true,
		RunWhenIdle:    true,
		TriggerCommand: req.TriggerCommand,
		TriggerOn:      req.TriggerOn,
		CreatedAt:      now,
	}
	if err := sched.ValidateJob(&j); err != nil {
		writeError(w, http.StatusBadRequest, codeInvalidRequest, err.Error())
		return
	}
	createJobReply(s, w, r, j)
}

// nextRunFor resolves the stored next fire for a job write: disabled jobs
// unschedule, enabled ones recompute when needed or keep their slot.
func nextRunFor(j store.Job, enabled bool, recompute bool) (*time.Time, error) {
	if !enabled {
		return nil, nil
	}
	if recompute {
		return sched.InitialNext(j, time.Now())
	}
	return j.NextRunAt, nil
}

// handleJobDelete removes one job, its run history survives unlinked.
func (s *apiServer) handleJobDelete(w http.ResponseWriter, r *http.Request) {
	err := s.sched.DeleteJob(r.Context(), pathID(r))
	if writeJobError(w, err) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleJobFire records and launches one manual fire of the job, disabled or
// not, its schedule is untouched. Execution continues in the background.
func (s *apiServer) handleJobFire(w http.ResponseWriter, r *http.Request) {
	run, err := s.sched.FireNow(r.Context(), pathID(r))
	switch {
	case err == nil:
		writeJSON(w, http.StatusAccepted, run)
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, codeJobNotFound, "")
	case errors.Is(err, store.ErrLiveRun), errors.Is(err, store.ErrCapacity):
		writeError(w, http.StatusConflict, codeConflict, err.Error())
	default:
		writeError(w, http.StatusInternalServerError, codeInternalError, "")
	}
}

// handleRuns serves run history newest first, optionally one job's only.
func (s *apiServer) handleRuns(w http.ResponseWriter, r *http.Request) {
	limit, ok := parseLimit(w, r)
	if !ok {
		return
	}
	var jobID int64
	if raw := r.URL.Query().Get("job"); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed < 1 {
			writeError(w, http.StatusBadRequest, codeInvalidRequest, "job must be a positive id")
			return
		}
		jobID = parsed
	}
	runs, err := s.sched.Runs(r.Context(), jobID, min(limit, maxRunLimit))
	if err != nil {
		writeError(w, http.StatusInternalServerError, codeInternalError, "")
		return
	}
	writeJSON(w, http.StatusOK, orEmptySlice(runs))
}

// pathID reads the {id} path value as a job id.
func pathID(r *http.Request) int64 {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	return id
}
