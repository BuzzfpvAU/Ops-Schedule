// Generate date objects for a range of dates
export function generateDateRange(startDate, endDate) {
  const dates = [];
  const current = new Date(startDate);
  const end = new Date(endDate);
  while (current <= end) {
    const dateStr = current.toISOString().slice(0, 10);
    const dayName = current.toLocaleDateString('en-AU', { weekday: 'short' });
    const dayNum = current.getDate();
    const month = current.toLocaleDateString('en-AU', { month: 'short' });
    const isWeekend = current.getDay() === 0 || current.getDay() === 6;
    const isToday = dateStr === new Date().toISOString().slice(0, 10);

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

// Get initial date range: 2 weeks back + 4 weeks forward from current Monday
export function getInitialDateRange() {
  const monday = getMondayOfWeek(0);
  const start = new Date(monday);
  start.setDate(start.getDate() - 14); // 2 weeks back
  const end = new Date(monday);
  end.setDate(end.getDate() + 27); // 4 weeks forward (28 days total from Monday)
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

// Extend a date range by adding days to the start or end
export function extendDateRange(currentStart, currentEnd, direction, days = 14) {
  if (direction === 'past') {
    const newStart = new Date(currentStart);
    newStart.setDate(newStart.getDate() - days);
    return {
      startDate: newStart.toISOString().slice(0, 10),
      endDate: new Date(new Date(currentStart).getTime() - 86400000).toISOString().slice(0, 10),
      rangeStart: newStart.toISOString().slice(0, 10),
      rangeEnd: currentEnd,
    };
  } else {
    const newEnd = new Date(currentEnd);
    newEnd.setDate(newEnd.getDate() + days);
    return {
      startDate: new Date(new Date(currentEnd).getTime() + 86400000).toISOString().slice(0, 10),
      endDate: newEnd.toISOString().slice(0, 10),
      rangeStart: currentStart,
      rangeEnd: newEnd.toISOString().slice(0, 10),
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
