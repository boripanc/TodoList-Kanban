/** How many finished cards a done column shows before the rest fold away. */
export const DONE_VISIBLE_LIMIT = 5

const DONE_WORDS = /\b(done|closed|complete|completed|finished)\b/i

/** A column counts as done when its title names finished work, such as "Done" or "Closed". */
export function isDoneColumn(title: string): boolean {
  return DONE_WORDS.test(title)
}
