// The calendar quarter that most recently ended on or before `today` (a
// "YYYY-MM-DD" date in the company's time zone): the default period of a new
// quarterly report. Pure.

export function lastEndedQuarter(today: string): {
  year: number;
  quarter: number;
} {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const current = Math.floor((month - 1) / 3) + 1;
  return current === 1
    ? { year: year - 1, quarter: 4 }
    : { year, quarter: current - 1 };
}
