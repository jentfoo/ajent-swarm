-- ajent-swarm schema: queued one-shot prompts. A queued row is a stored job
-- whose shape the queue endpoint pins; the explicit flag keeps the marker
-- stable as other job fields become editable.

ALTER TABLE jobs ADD COLUMN queued INTEGER NOT NULL DEFAULT 0;
