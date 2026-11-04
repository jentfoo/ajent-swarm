-- ajent-swarm schema: per-job tool selection. A custom set is the whole
-- enabled list at launch; the flag off means "session default, do not touch
-- the tool set".

ALTER TABLE jobs ADD COLUMN tools TEXT NOT NULL DEFAULT ''; -- comma list of enabled tool names
ALTER TABLE jobs ADD COLUMN tools_custom INTEGER NOT NULL DEFAULT 0;
