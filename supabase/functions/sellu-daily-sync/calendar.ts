export function addCalendarDays(ymdStr: string, deltaDays: number): string {
  const [y0, mo0, d0] = ymdStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y0, mo0 - 1, d0 + deltaDays));
  return dt.toISOString().slice(0, 10);
}

export function todayYmdInTimeZone(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function yesterdayYmdInTimeZone(timeZone: string): string {
  return addCalendarDays(todayYmdInTimeZone(timeZone), -1);
}

export function selluCalendarDayWindow(calendarYmd: string): {
  start: string;
  end: string;
  calendarDay: string;
} {
  return {
    start: `${calendarYmd} 00:00:00`,
    end: `${calendarYmd} 23:59:59`,
    calendarDay: calendarYmd,
  };
}
