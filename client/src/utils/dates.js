// Get today's date string in AEST (Australia/Sydney)
function getTodayAEST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
}

// Generate date objects for a range of dates
export function generateDateRange(startDate, endDate) {
  const dates = [];
  const current = new Date(startDate);
  const end = new Date(endDate);
  const todayStr = getTodayAEST();
  while (current <= end) {
    const dateStr = toDateStr(current);
    const dayName = current.toLocaleDateString('en-AU', { weekday: 'short' });
    const dayNum = current.getDate();
    const month = current.toLocaleDateString('en-AU', { month: 'short' });
    const isWeekend = current.getDay() === 0 || current.getDay() === 6;
    const isToday = dateStr === todayStr;

    dates.push({ date: new Date(current), dateStr, dayName, dayNum, month, isWeekend, isToday });
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

// Get the Monday of the current week
export function getMondayOfWeek(offset = 0) {
  const today = new Date();
  const dayOfWeek = today.getDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(today);
  monday.setDate(today.getDate() + mondayOffset + offset * 7);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

// Format a Date to YYYY-MM-DD string (local time, not UTC)
function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Get initial date range: 2 weeks back + 4 weeks forward from current Monday
export function getInitialDateRange() {
  const monday = getMondayOfWeek(0);
  const start = new Date(monday);
  start.setDate(start.getDate() - 14); // 2 weeks back
  const end = new Date(monday);
  end.setDate(end.getDate() + 27); // 4 weeks forward (28 days total from Monday)
  return {
    startDate: toDateStr(start),
    endDate: toDateStr(end),
  };
}

// Extend a date range by adding days to the start or end
export function extendDateRange(currentStart, currentEnd, direction, days = 14) {
  if (direction === 'past') {
    const newStart = new Date(currentStart);
    newStart.setDate(newStart.getDate() - days);
    const dayBefore = new Date(currentStart);
    dayBefore.setDate(dayBefore.getDate() - 1);
    return {
      startDate: toDateStr(newStart),
      endDate: toDateStr(dayBefore),
      rangeStart: toDateStr(newStart),
      rangeEnd: currentEnd,
    };
  } else {
    const newEnd = new Date(currentEnd);
    newEnd.setDate(newEnd.getDate() + days);
    const dayAfter = new Date(currentEnd);
    dayAfter.setDate(dayAfter.getDate() + 1);
    return {
      startDate: toDateStr(dayAfter),
      endDate: toDateStr(newEnd),
      rangeStart: currentStart,
      rangeEnd: toDateStr(newEnd),
    };
  }
}

// Legacy: kept for compatibility with other components
export function getWeekDates(weekOffset = 0) {
  const monday = getMondayOfWeek(weekOffset);
  const end = new Date(monday);
  end.setDate(end.getDate() + 13); // 14 days
  return generateDateRange(monday, end);
}

export function formatDateRange(dates) {
  if (dates.length === 0) return '';
  const first = dates[0];
  const last = dates[dates.length - 1];
  const startMonth = first.date.toLocaleDateString('en-AU', { month: 'long' });
  const endMonth = last.date.toLocaleDateString('en-AU', { month: 'long' });
  const year = first.date.getFullYear();

  if (startMonth === endMonth) {
    return `${first.dayNum} - ${last.dayNum} ${startMonth} ${year}`;
  }
  return `${first.dayNum} ${startMonth} - ${last.dayNum} ${endMonth} ${year}`;
}

export function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
}
