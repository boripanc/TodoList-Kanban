-- People cards on a board can be assigned to ({id, name, color, capacity} each),
-- and who each card is assigned to (ids from the board's team).
alter table kanban.boards add column team jsonb not null default '[]'::jsonb;
alter table kanban.cards add column assignee_ids jsonb not null default '[]'::jsonb;
