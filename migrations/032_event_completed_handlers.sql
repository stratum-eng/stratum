-- Event processing runs an ordered set of handlers (analytics, issue-autoclose,
-- webhooks). Previously a failure in any handler retried the WHOLE event,
-- re-running handlers that had already succeeded (duplicate analytics, redundant
-- issue closes, potential duplicate webhook deliveries). Record which handlers
-- have completed so a retry resumes from the failed one instead of the top.
ALTER TABLE events ADD COLUMN completed_handlers TEXT NOT NULL DEFAULT '[]';
