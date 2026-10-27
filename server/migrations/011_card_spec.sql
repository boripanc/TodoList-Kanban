-- The technical spec of an interface a card stands for (kind, endpoint,
-- input, output, notes, status), or null for ordinary cards.
alter table kanban.cards add column spec jsonb;
