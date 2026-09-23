export function formatZonedTime(now: Date, timezone: string | null): string {
  if (!timezone) return '--:--:--'
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(now)
  } catch {
    return '--:--:--'
  }
}
