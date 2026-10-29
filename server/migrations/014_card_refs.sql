-- The R4C (request for change) and DD numbers a card's work belongs to, kept
-- on cards of boards that are not Project boards. Empty when none.
alter table kanban.cards add column r4c_no text not null default '';
alter table kanban.cards add column dd_no text not null default '';
