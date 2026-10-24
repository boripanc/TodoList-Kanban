-- When work on a card starts (YYYY-MM-DD); with due_date it gives the card's
-- date range. R4C and Project cards need both.
alter table kanban.cards add column start_date text;
