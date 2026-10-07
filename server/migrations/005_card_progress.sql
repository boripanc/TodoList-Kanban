-- How far along a card is (0-100, null when not tracked) and its progress updates.
alter table kanban.cards
  add column progress smallint check (progress between 0 and 100),
  add column progress_log jsonb not null default '[]'::jsonb;
