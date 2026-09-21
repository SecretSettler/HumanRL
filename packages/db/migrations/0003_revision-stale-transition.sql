CREATE OR REPLACE FUNCTION intenttrace_allow_revision_stale_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  requested_stale boolean := NEW.stale;
BEGIN
  IF OLD.stale = false AND requested_stale = true THEN
    NEW.stale := OLD.stale;
    IF NEW IS NOT DISTINCT FROM OLD THEN
      NEW.stale := requested_stale;
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'IntentTrace semantic revision content is immutable; only stale=false to stale=true is permitted'
    USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint

DROP TRIGGER semantic_revisions_immutable ON semantic_revisions;--> statement-breakpoint

CREATE TRIGGER semantic_revisions_immutable BEFORE UPDATE ON semantic_revisions
FOR EACH ROW EXECUTE FUNCTION intenttrace_allow_revision_stale_transition();
