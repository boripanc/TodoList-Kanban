-- Files attached to cards, e.g. interface specs in Word or Excel. The file
-- itself is kept here (bytea), so a backup of the database holds everything.
-- Deleting a card or board deletes its files.
create table kanban.attachments (
  id uuid primary key default gen_random_uuid(),
  card_id text not null references kanban.cards (id) on delete cascade,
  board_id text not null references kanban.boards (id) on delete cascade,
  name text not null,
  type text not null,
  size integer not null,
  data bytea not null,
  uploaded_by uuid references kanban.users (id) on delete set null,
  uploaded_at timestamptz not null default now()
);
create index attachments_board_id_idx on kanban.attachments (board_id);
create index attachments_card_id_idx on kanban.attachments (card_id);

-- An added or removed file counts as a board change, so open apps show it.
create trigger attachments_touch_insert after insert on kanban.attachments
  referencing new table as changed for each statement execute function kanban.touch_boards();
create trigger attachments_touch_delete after delete on kanban.attachments
  referencing old table as changed for each statement execute function kanban.touch_boards();
