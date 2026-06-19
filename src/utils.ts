type RelativeTimeProps = {
  locale?: string
}

export function timeFromNow(time: number, { locale = 'zh-CN' }: RelativeTimeProps = {}) {
  const relativeTimeFormat = new Intl.RelativeTimeFormat(locale, {
    numeric: 'auto',
    style: 'short',
  })
  const offset = time - Date.now()
  const offsetInSec = offset / 1000
  const offsetInMin = offsetInSec / 60
  const offsetInHour = offsetInMin / 60
  const offsetInDay = offsetInHour / 24

  let unit: Intl.RelativeTimeFormatUnit = 'second'
  let value = offsetInSec

  if (Math.abs(offsetInDay) >= 1) {
    unit = 'day'
    value = offsetInDay
  } else if (Math.abs(offsetInHour) >= 1) {
    unit = 'hour'
    value = offsetInHour
  } else if (Math.abs(offsetInMin) >= 1) {
    unit = 'minute'
    value = offsetInMin
  }

  return relativeTimeFormat.format(Math.round(value), unit)
}

/** Format a duration in milliseconds as a short zh-CN string, e.g. "3小时42分". */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60

  if (hours > 0 && minutes > 0) return `${hours}小时${minutes}分`
  if (hours > 0) return `${hours}小时`
  return `${minutes}分`
}
