package sched

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/jentfoo/ajent-swarm/pkg/store"
)

// atZone builds a wall-clock time in a named zone for schedule assertions.
func atZone(t *testing.T, name, clock string) time.Time {
	t.Helper()
	loc, err := time.LoadLocation(name)
	require.NoError(t, err)
	ts, err := time.ParseInLocation("2006-01-02 15:04:05", clock, loc)
	require.NoError(t, err)
	return ts
}

func TestSchedule(t *testing.T) {
	t.Parallel()

	t.Run("interval_anchors_on_creation", func(t *testing.T) {
		created := atZone(t, "UTC", "2025-05-01 12:00:00")
		s := schedule{Kind: store.ScheduleInterval, Interval: 30 * time.Minute}

		tests := []struct {
			name string
			from string
			want string
		}{
			{"just_after_creation", "2025-05-01 12:00:01", "2025-05-01 12:30"},
			{"mid_window_rounds_up", "2025-05-01 12:31:00", "2025-05-01 13:00"},
			{"exact_boundary_moves_on", "2025-05-01 12:30:00", "2025-05-01 13:00"},
			{"long_gap_never_storms", "2025-05-02 09:47:00", "2025-05-02 10:00"},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				from := atZone(t, "UTC", tt.from)
				next, err := s.NextAfter(created, from)
				require.NoError(t, err)
				assert.True(t, next.After(from))
				assert.Equal(t, tt.want, next.Format("2006-01-02 15:04"))
			})
		}
	})

	t.Run("daily_wall_clock", func(t *testing.T) {
		loc := "America/New_York"
		s := schedule{Kind: store.ScheduleDaily, DailyTime: "09:00", Loc: mustLoc(t, loc)}
		created := atZone(t, loc, "2025-05-01 08:00:00")

		tests := []struct {
			name string
			from string
			want string
		}{
			{"before_today_fire", "2025-05-01 08:00:00", "2025-05-01 09:00"},
			{"after_today_fire_tomorrow", "2025-05-01 09:00:01", "2025-05-02 09:00"},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				from := atZone(t, loc, tt.from)
				next, err := s.NextAfter(created, from)
				require.NoError(t, err)
				assert.True(t, next.After(from))
				assert.Equal(t, tt.want, next.In(mustLoc(t, loc)).Format("2006-01-02 15:04"))
			})
		}
	})

	t.Run("daily_dst_edges", func(t *testing.T) {
		loc := "America/New_York"
		s := schedule{Kind: store.ScheduleDaily, DailyTime: "02:30", Loc: mustLoc(t, loc)}

		// spring forward skips 02:30; Go normalizes the nonexistent wall clock to
		// its valid pre-transition reading (01:30 EST = UTC-5), the same instant
		// 02:30 EDT would have been
		spring := atZone(t, loc, "2025-03-09 01:00:00") // clocks jump 02:00 -> 03:00
		next, err := s.NextAfter(spring.Add(-time.Hour), spring)
		require.NoError(t, err)
		assert.Equal(t, "06:30", next.UTC().Format("15:04")) // = 02:30 EDT

		// fall back repeats 01:xx; the wall clock resolves to one unambiguous slot
		fall := atZone(t, loc, "2025-11-02 00:59:00") // just before 01:00 happens twice
		next, err = s.NextAfter(fall.Add(-time.Hour), fall)
		require.NoError(t, err)
		assert.Equal(t, "07:30", next.UTC().Format("15:04")) // = 02:30 EST
	})

	t.Run("parse_daily_time", func(t *testing.T) {
		tests := []struct {
			name  string
			raw   string
			hour  int
			min   int
			error bool
		}{
			{"midnight", "00:00", 0, 0, false},
			{"normal", "09:30", 9, 30, false},
			{"late", "23:59", 23, 59, false},
			{"spaces_trim", " 7:05 ", 7, 5, false},
			{"missing_colon", "0900", 0, 0, true},
			{"hour_out_of_range", "24:00", 0, 0, true},
			{"minute_out_of_range", "09:60", 0, 0, true},
			{"not_numbers", "aa:bb", 0, 0, true},
			{"empty", "", 0, 0, true},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				hour, min, err := parseDailyTime(tt.raw)
				if tt.error {
					require.Error(t, err)
					return
				}
				require.NoError(t, err)
				assert.Equal(t, tt.hour, hour)
				assert.Equal(t, tt.min, min)
			})
		}
	})

	t.Run("initial_next_per_kind", func(t *testing.T) {
		now := atZone(t, "UTC", "2025-05-01 12:00:00")

		t.Run("once_keeps_its_slot", func(t *testing.T) {
			slot := now.Add(time.Hour)
			j := sampleJob(store.ScheduleOnce)
			j.CreatedAt = now
			j.NextRunAt = &slot
			next, err := InitialNext(j, now)
			require.NoError(t, err)
			assert.True(t, next.Equal(slot))
		})

		t.Run("interval_first_fire_out", func(t *testing.T) {
			j := sampleJob(store.ScheduleInterval)
			j.CreatedAt = now
			j.IntervalSeconds = 600
			next, err := InitialNext(j, now.Add(time.Second))
			require.NoError(t, err)
			assert.True(t, next.Equal(now.Add(10*time.Minute)))
		})

		t.Run("daily_first_fire_next", func(t *testing.T) {
			j := sampleJob(store.ScheduleDaily)
			j.CreatedAt = now
			j.DailyTime = "09:00"
			j.TZ = "UTC" // pin the zone; empty means server local
			next, err := InitialNext(j, now)
			require.NoError(t, err)
			assert.Equal(t, "2025-05-02 09:00", next.UTC().Format("2006-01-02 15:04"))
		})
	})

	t.Run("validate_job", func(t *testing.T) {
		tests := []struct {
			name    string
			mutate  func(j *store.Job)
			wantErr string
		}{
			// the workspace must exist for every case to reach its own check
			{"interval_ok", nil, ""},
			{"once_ok", func(j *store.Job) {
				j.ScheduleKind = store.ScheduleOnce
				slot := time.Now().Add(time.Hour)
				j.NextRunAt = &slot
			}, ""},
			{"daily_with_zone", func(j *store.Job) {
				j.ScheduleKind = store.ScheduleDaily
				j.TZ = "Europe/Berlin"
			}, ""},
			{"defaults_spawn_mode_and_policies", func(j *store.Job) {}, ""},
			{"empty_name", func(j *store.Job) { j.Name = "  " }, "name is required"},
			{"missing_workspace", func(j *store.Job) { j.Workspace = "/nonexistent-really" },
				"workspace"},
			{"bad_spawn_mode", func(j *store.Job) { j.SpawnMode = "fork" }, "unknown spawn mode"},
			{"resume_needs_target", func(j *store.Job) { j.SpawnMode = "resume" },
				"resume needs a session target"},
			{"bad_permission", func(j *store.Job) { j.Permission = "yolo" }, "unknown permission"},
			{"once_requires_slot", func(j *store.Job) { j.ScheduleKind = store.ScheduleOnce },
				"requires next_run_at"},
			{"interval_needs_positive", func(j *store.Job) { j.IntervalSeconds = 0 },
				"must be positive"},
			{"bad_daily_time", func(j *store.Job) {
				j.ScheduleKind = store.ScheduleDaily
				j.DailyTime = "25:00"
			}, "HH:MM"},
			{"bad_zone", func(j *store.Job) {
				j.ScheduleKind = store.ScheduleDaily
				j.TZ = "Mars/Olympus"
			}, "unknown timezone"},
			{"bad_overlap", func(j *store.Job) { j.Overlap = "sometimes" }, "overlap policy"},
			{"bad_on_missed", func(j *store.Job) { j.OnMissed = "explode" }, "on_missed policy"},
			{"negative_timeout", func(j *store.Job) { j.TimeoutMinutes = -1 }, "timeout_minutes"},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				j := sampleJob(store.ScheduleInterval)
				j.Workspace = t.TempDir()
				if tt.mutate != nil {
					tt.mutate(&j)
				}
				err := ValidateJob(&j)
				if tt.wantErr == "" {
					require.NoError(t, err)
					return
				}
				require.Error(t, err)
				assert.Contains(t, err.Error(), tt.wantErr)
			})
		}
	})

	t.Run("validate_normalizes_defaults", func(t *testing.T) {
		j := sampleJob(store.ScheduleInterval)
		j.Name = "  nightly  "
		j.Workspace = t.TempDir()
		j.SpawnMode = ""
		require.NoError(t, ValidateJob(&j))
		assert.Equal(t, "nightly", j.Name)
		assert.Equal(t, "new", j.SpawnMode)
		assert.Equal(t, store.MissSkip, j.OnMissed)
		assert.Equal(t, store.OverlapRun, j.Overlap)

		j.SessionTarget = " 01ABC "
		j.SpawnMode = "resume"
		require.NoError(t, ValidateJob(&j))
		assert.Equal(t, "01ABC", j.SessionTarget) // targets trim like names do
	})

	t.Run("validate_queued_pins_shape", func(t *testing.T) {
		slot := time.Now().Add(time.Hour)
		j := sampleJob(store.ScheduleInterval)
		j.Workspace = t.TempDir()
		j.Queued = true
		// every fixed field arrives drifted, the way an edit round trip could
		// send them
		j.SpawnMode = "resume"
		j.SessionTarget = "01ABC"
		j.DailyTime = "09:00"
		j.TZ = "Europe/Berlin"
		j.Weekdays = "mon"
		j.KeepAlive = false
		j.RunWhenIdle = false
		j.IdleMaxDelaySeconds = 3600
		j.NextRunAt = &slot
		require.NoError(t, ValidateJob(&j))

		assert.Equal(t, store.ScheduleOnce, j.ScheduleKind)
		assert.Equal(t, "new", j.SpawnMode)
		assert.Empty(t, j.SessionTarget)
		assert.Empty(t, j.DailyTime)
		assert.Empty(t, j.TZ)
		assert.Empty(t, j.Weekdays)
		assert.Zero(t, j.IntervalSeconds)
		assert.True(t, j.RunWhenIdle)
		assert.Zero(t, j.IdleMaxDelaySeconds) // unlimited wait, never skips
		assert.True(t, j.KeepAlive)
		// the slot itself survives: the queue's wait is not disturbed
		require.NotNil(t, j.NextRunAt)
		assert.True(t, j.NextRunAt.Equal(slot))

		// a queued row still needs its slot, like every once job
		noSlot := sampleJob(store.ScheduleInterval)
		noSlot.Workspace = t.TempDir()
		noSlot.Queued = true
		err := ValidateJob(&noSlot)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "next_run_at")

		// plain rows keep their own shape untouched
		plain := sampleJob(store.ScheduleInterval)
		plain.Workspace = t.TempDir()
		plain.RunWhenIdle = true
		plain.IdleMaxDelaySeconds = 3600
		require.NoError(t, ValidateJob(&plain))
		assert.False(t, plain.Queued)
		assert.Equal(t, store.ScheduleInterval, plain.ScheduleKind)
		assert.Equal(t, 3600, plain.IdleMaxDelaySeconds)
	})

	t.Run("preview_interval_anchors", func(t *testing.T) {
		j := sampleJob(store.ScheduleInterval)
		j.IntervalSeconds = 1800
		j.CreatedAt = atZone(t, "UTC", "2025-05-01 12:00:00")
		from := atZone(t, "UTC", "2025-05-02 09:47:00")

		times, err := PreviewTimes(j, from, 3)
		require.NoError(t, err)
		require.Len(t, times, 3)
		// slots march the creation anchor, exactly as the trigger loop advances
		assert.Equal(t, "2025-05-02 10:00", times[0].UTC().Format("2006-01-02 15:04"))
		assert.Equal(t, "2025-05-02 10:30", times[1].UTC().Format("2006-01-02 15:04"))
		assert.Equal(t, "2025-05-02 11:00", times[2].UTC().Format("2006-01-02 15:04"))
	})

	t.Run("preview_daily_dst", func(t *testing.T) {
		loc := "America/New_York"
		j := sampleJob(store.ScheduleDaily)
		j.DailyTime = "02:30"
		j.TZ = loc
		j.CreatedAt = atZone(t, loc, "2025-01-01 00:00:00")

		t.Run("spring_forward", func(t *testing.T) {
			// the 02:30 wall clock does not exist on 2025-03-09; Go normalizes it
			// to its post-transition instant (02:30 EDT = 06:30Z), and each later
			// day fires at that same UTC time while EDT lasts
			from := atZone(t, loc, "2025-03-09 01:00:00")
			times, err := PreviewTimes(j, from, 3)
			require.NoError(t, err)
			for i, want := range []string{"06:30", "06:30", "06:30"} {
				assert.Equal(t, want+" UTC", times[i].UTC().Format("15:04 MST"))
			}
		})

		t.Run("fall_back", func(t *testing.T) {
			// 2025-11-02 repeats 01:xx; the 02:30 slot resolves to one instant
			// (02:30 EST = 07:30Z)
			from := atZone(t, loc, "2025-11-02 00:59:00")
			times, err := PreviewTimes(j, from, 2)
			require.NoError(t, err)
			for i, want := range []string{"07:30", "07:30"} {
				assert.Equal(t, want+" UTC", times[i].UTC().Format("15:04 MST"))
			}
		})
	})

	t.Run("preview_once_and_errors", func(t *testing.T) {
		now := atZone(t, "UTC", "2025-05-01 12:00:00")

		t.Run("once_answers_its_slot", func(t *testing.T) {
			j := sampleJob(store.ScheduleOnce)
			slot := now.Add(2 * time.Hour)
			j.NextRunAt = &slot
			times, err := PreviewTimes(j, now, 3)
			require.NoError(t, err)
			require.Len(t, times, 1) // a once job has exactly one fire
			assert.True(t, times[0].Equal(slot))
		})

		t.Run("once_requires_slot", func(t *testing.T) {
			j := sampleJob(store.ScheduleOnce)
			_, err := PreviewTimes(j, now, 3)
			require.Error(t, err)
			assert.Contains(t, err.Error(), "next_run_at")
		})

		t.Run("unknown_kind_errors", func(t *testing.T) {
			j := sampleJob("weekly")
			_, err := PreviewTimes(j, now, 3)
			require.Error(t, err)
		})

		t.Run("zero_count_answers_nothing", func(t *testing.T) {
			j := sampleJob(store.ScheduleInterval)
			times, err := PreviewTimes(j, now, 0)
			require.NoError(t, err)
			assert.Empty(t, times)
		})

		t.Run("zero_created_anchors_on_from", func(t *testing.T) {
			// what a save does for a brand-new draft: anchor at that moment
			j := sampleJob(store.ScheduleInterval)
			j.IntervalSeconds = 600
			times, err := PreviewTimes(j, now, 2)
			require.NoError(t, err)
			assert.True(t, times[0].Equal(now.Add(10*time.Minute)))
		})
	})

	t.Run("check_workspace", func(t *testing.T) {
		t.Run("directory_passes", func(t *testing.T) {
			require.NoError(t, CheckWorkspace(t.TempDir()))
		})
		t.Run("missing_fails", func(t *testing.T) {
			require.Error(t, CheckWorkspace("/nonexistent-swarm-check"))
		})
	})

	t.Run("parse_weekdays", func(t *testing.T) {
		t.Run("empty_means_every_day", func(t *testing.T) {
			days, err := parseWeekdays("")
			require.NoError(t, err)
			assert.Empty(t, days)
			days, err = parseWeekdays("  ")
			require.NoError(t, err)
			assert.Empty(t, days)
		})

		t.Run("tokens_case_insensitive", func(t *testing.T) {
			days, err := parseWeekdays("Mon, WED , fri")
			require.NoError(t, err)
			assert.Equal(t, []time.Weekday{time.Monday, time.Wednesday, time.Friday}, days)
		})

		t.Run("unknown_token_errors", func(t *testing.T) {
			_, err := parseWeekdays("mon,funday")
			require.Error(t, err)
			assert.Contains(t, err.Error(), "funday")
		})

		t.Run("duplicate_errors", func(t *testing.T) {
			_, err := parseWeekdays("mon,mon")
			require.Error(t, err)
		})
	})

	t.Run("daily_with_weekdays", func(t *testing.T) {
		// 2025-05-01 is a Thursday; the restriction keeps mondays only
		s := schedule{Kind: store.ScheduleDaily, DailyTime: "09:00",
			Loc: mustLoc(t, "UTC"), Weekdays: []time.Weekday{time.Monday}}

		next, err := s.NextAfter(atZone(t, "UTC", "2025-05-01 08:00:00"),
			atZone(t, "UTC", "2025-05-01 08:00:00"))
		require.NoError(t, err)
		assert.Equal(t, "2025-05-05 09:00", next.Format("2006-01-02 15:04")) // next monday

		// a slot already on a chosen day stays put
		next, err = s.NextAfter(atZone(t, "UTC", "2025-05-05 08:00:00"),
			atZone(t, "UTC", "2025-05-05 08:00:00"))
		require.NoError(t, err)
		assert.Equal(t, "2025-05-05 09:00", next.Format("2006-01-02 15:04"))

		// past the chosen day's slot, the following week answers
		next, err = s.NextAfter(atZone(t, "UTC", "2025-05-05 08:00:00"),
			atZone(t, "UTC", "2025-05-05 09:30:00"))
		require.NoError(t, err)
		assert.Equal(t, "2025-05-12 09:00", next.Format("2006-01-02 15:04"))
	})

	t.Run("interval_with_weekdays", func(t *testing.T) {
		// slots anchored hourly from thursday noon; only fridays may fire
		created := atZone(t, "UTC", "2025-05-01 12:00:00")
		s := schedule{Kind: store.ScheduleInterval, Interval: time.Hour,
			Loc: mustLoc(t, "UTC"), Weekdays: []time.Weekday{time.Friday}}

		next, err := s.NextAfter(created, atZone(t, "UTC", "2025-05-01 12:30:00"))
		require.NoError(t, err)
		assert.Equal(t, "2025-05-02 00:00", next.Format("2006-01-02 15:04")) // first friday slot

		next, err = s.NextAfter(created, atZone(t, "UTC", "2025-05-02 06:00:00"))
		require.NoError(t, err)
		assert.Equal(t, "2025-05-02 07:00", next.Format("2006-01-02 15:04")) // still friday

		// saturday slots skip to the next friday
		next, err = s.NextAfter(created, atZone(t, "UTC", "2025-05-03 06:00:00"))
		require.NoError(t, err)
		assert.Equal(t, "2025-05-09 00:00", next.Format("2006-01-02 15:04"))
	})

	t.Run("validate_tools", func(t *testing.T) {
		t.Run("custom_off_clears_tools", func(t *testing.T) {
			j := sampleJob(store.ScheduleInterval)
			j.Workspace = t.TempDir()
			j.ToolsCustom = false
			j.Tools = "builtin:read"
			require.NoError(t, ValidateJob(&j))
			assert.Empty(t, j.Tools) // the stored list never outlives its flag
		})

		t.Run("custom_on_normalizes", func(t *testing.T) {
			j := sampleJob(store.ScheduleInterval)
			j.Workspace = t.TempDir()
			j.ToolsCustom = true
			j.Tools = " web_search , builtin:read,,web_search "
			require.NoError(t, ValidateJob(&j))
			assert.Equal(t, "builtin:read,web_search", j.Tools)
		})

		t.Run("custom_empty_runs_toolless", func(t *testing.T) {
			j := sampleJob(store.ScheduleInterval)
			j.Workspace = t.TempDir()
			j.ToolsCustom = true // an empty list is a valid tool-less set
			require.NoError(t, ValidateJob(&j))
			assert.Empty(t, j.Tools)
		})

		t.Run("oversized_list_rejected", func(t *testing.T) {
			j := sampleJob(store.ScheduleInterval)
			j.Workspace = t.TempDir()
			j.ToolsCustom = true
			names := make([]string, maxPrefixLen/10+2) // distinct names never collapse
			for i := range names {
				names[i] = fmt.Sprintf("tool-%04d", i)
			}
			j.Tools = strings.Join(names, ",")
			err := ValidateJob(&j)
			require.Error(t, err)
			assert.Contains(t, err.Error(), "tools")
		})
	})

	t.Run("validate_trigger_fields", func(t *testing.T) {
		tests := []struct {
			name    string
			mutate  func(j *store.Job)
			wantErr string
		}{
			{"trigger_defaults_to_success", func(j *store.Job) {}, ""},
			{"trigger_error_ok", func(j *store.Job) { j.TriggerOn = store.TriggerOnError }, ""},
			{"trigger_on_unknown", func(j *store.Job) { j.TriggerOn = "maybe" }, "trigger_on"},
			{"negative_idle_delay", func(j *store.Job) { j.IdleMaxDelaySeconds = -1 },
				"idle_max_delay_seconds"},
			{"idle_delay_over_cap", func(j *store.Job) { j.IdleMaxDelaySeconds = maxIdleDelaySec + 1 },
				"idle_max_delay_seconds"},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				j := sampleJob(store.ScheduleInterval)
				j.Workspace = t.TempDir()
				if tt.mutate != nil {
					tt.mutate(&j)
				}
				err := ValidateJob(&j)
				if tt.wantErr == "" {
					require.NoError(t, err)
					return
				}
				require.Error(t, err)
				assert.Contains(t, err.Error(), tt.wantErr)
			})
		}

		t.Run("weekdays_normalize", func(t *testing.T) {
			j := sampleJob(store.ScheduleInterval)
			j.Workspace = t.TempDir()
			j.Weekdays = "FRI, mon"
			require.NoError(t, ValidateJob(&j))
			assert.Equal(t, "mon,fri", j.Weekdays)
		})

		t.Run("weekdays_unknown_rejected", func(t *testing.T) {
			j := sampleJob(store.ScheduleInterval)
			j.Workspace = t.TempDir()
			j.Weekdays = "monday"
			err := ValidateJob(&j)
			require.Error(t, err)
			assert.Contains(t, err.Error(), "monday")
		})
	})

	t.Run("weekdays_default_zone", func(t *testing.T) {
		// interval schedules carry no Loc of their own; the weekday check must not
		// panic on a nil location and answers in server-local time instead
		created := time.Date(2025, 5, 1, 12, 0, 0, 0, time.Local) // a thursday
		s := schedule{Kind: store.ScheduleInterval, Interval: time.Hour,
			Weekdays: []time.Weekday{time.Friday}}

		next, err := s.NextAfter(created, created.Add(30*time.Minute))
		require.NoError(t, err)
		assert.Equal(t, time.Friday, next.In(time.Local).Weekday())
	})
}

func mustLoc(t *testing.T, name string) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation(name)
	require.NoError(t, err)
	return loc
}

func sampleJob(kind string) store.Job {
	return store.Job{
		Name:            "sample",
		Workspace:       "/repo",
		Prompt:          "go",
		SpawnMode:       "new",
		ScheduleKind:    kind,
		IntervalSeconds: 60,
		DailyTime:       "09:00",
		OnMissed:        store.MissSkip,
		Overlap:         store.OverlapRun,
	}
}
