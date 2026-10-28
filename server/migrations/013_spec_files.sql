-- Interface specs no longer have source and target message fields: the
-- technical and mapping spec files hold that now. Any text written in them
-- moves to the end of the notes, so nothing is lost.
update kanban.cards
set spec = (spec - 'input' - 'output') || jsonb_build_object(
  'notes',
  concat_ws(
    E'\n\n',
    nullif(btrim(coalesce(spec->>'notes', '')), ''),
    'Source message:' || E'\n' || nullif(btrim(coalesce(spec->>'input', '')), ''),
    'Target message and mapping:' || E'\n' || nullif(btrim(coalesce(spec->>'output', '')), '')
  )
)
where spec is not null and (spec ? 'input' or spec ? 'output');

-- Which part of the spec a file is: the technical spec, the mapping spec, or
-- anything else. Files added before this are "other".
alter table kanban.attachments
  add column category text not null default 'other'
  check (category in ('technical', 'mapping', 'other'));

-- Moving a file to another section counts as a board change too.
create trigger attachments_touch_update after update on kanban.attachments
  referencing new table as changed for each statement execute function kanban.touch_boards();
