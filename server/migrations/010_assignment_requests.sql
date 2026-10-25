-- Assignments asked for through MCP (AI agents and automation) wait here until
-- the board owner approves or rejects them in the app. One request per card:
-- a newer request replaces the older one. `assignees` is a list of
-- {id, name}; id is null for a name the board team does not have yet, which
-- joins the team only once the request is approved.
create table kanban.assignment_requests (
  card_id text primary key references kanban.cards (id) on delete cascade,
  board_id text not null references kanban.boards (id) on delete cascade,
  assignees jsonb not null,
  requested_by uuid references kanban.users (id) on delete set null,
  requested_at timestamptz not null default now()
);
create index assignment_requests_board_id_idx on kanban.assignment_requests (board_id);

-- A new, changed or settled request counts as a board change, so open apps
-- hear about it and the owner sees it right away.
create trigger assignment_requests_touch_insert after insert on kanban.assignment_requests
  referencing new table as changed for each statement execute function kanban.touch_boards();
create trigger assignment_requests_touch_update after update on kanban.assignment_requests
  referencing new table as changed for each statement execute function kanban.touch_boards();
create trigger assignment_requests_touch_delete after delete on kanban.assignment_requests
  referencing old table as changed for each statement execute function kanban.touch_boards();
