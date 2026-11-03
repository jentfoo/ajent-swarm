-- ajent-swarm schema, phase 14: richer job triggers. Weekdays restrict
-- recurring schedules to chosen days; run-when-idle holds a fire until the
-- fleet has been quiet, with an optional delay cap; a trigger command gates
-- each fire on its own exit status.

ALTER TABLE jobs ADD COLUMN weekdays TEXT NOT NULL DEFAULT ''; -- comma list of sun..sat
ALTER TABLE jobs ADD COLUMN run_when_idle INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN idle_max_delay_seconds INTEGER NOT NULL DEFAULT 0; -- 0 = wait forever
ALTER TABLE jobs ADD COLUMN trigger_command TEXT NOT NULL DEFAULT '';
ALTER TABLE jobs ADD COLUMN trigger_on TEXT NOT NULL DEFAULT 'success'; -- success | error
