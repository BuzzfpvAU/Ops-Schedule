// Get 14 dates (2 weeks) starting from Monday of the week at the given offset
export function getWeekDates(weekOffset = 0) {
  const today = new Date();
  const dayOfWeek = today.getDay();
  // Adjust to Monday (day 1). If Sunday (0), go back 6 days
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(today);
  monday.setDate(today.getDate() + mondayOffset + weekOffset * 7);

  const dates = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const dayName = d.toLocaleDateString('en-AU', { weekday: 'short' });
    const dayNum = d.getDate();
    const month = d.toLocaleDateString('en-AU', { month: 'short' });
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    const isToday = dateStr === new Date().toISOString().slice(0, 10);

    dates.push({ date: d, dateStr, dayName, dayNum, month, isWeekend, isToday });
  }
  return dates;
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
