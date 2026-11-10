export type Point = [number, number]
/** Monotone cubic interpolation: passes through every sample, with no invented extrema. */
export function smoothSegments(points: Point[]) {
  if (points.length < 2) return []
  const slopes = points.slice(1).map((p, i) => (p[1] - points[i][1]) / (p[0] - points[i][0]))
  const tangents = points.map((_, i) => i === 0 ? slopes[0] : i === points.length - 1 ? slopes[i - 1] : slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2)
  slopes.forEach((slope, i) => {
    if (!slope) { tangents[i] = tangents[i + 1] = 0; return }
    const a = tangents[i] / slope, b = tangents[i + 1] / slope
    const norm = Math.hypot(a, b)
    if (norm > 3) { const scale = 3 / norm; tangents[i] = scale * a * slope; tangents[i + 1] = scale * b * slope }
  })
  return points.slice(1).map((end, i) => {
    const start = points[i], width = (end[0] - start[0]) / 3
    return { start, end, c1: [start[0] + width, start[1] + width * tangents[i]] as Point, c2: [end[0] - width, end[1] - width * tangents[i + 1]] as Point }
  })
}
export function smoothPath(points: Point[]) {
  if (!points.length) return ''
  return `M${points[0].join(',')}` + smoothSegments(points).map(({ c1, c2, end }) => ` C${c1.join(',')} ${c2.join(',')} ${end.join(',')}`).join('')
}
