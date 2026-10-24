export function checkedProfile(value = 'default') {
  if (value !== 'default' && value !== 'health') throw new Error('Unknown watch profile')
  return value
}
export function profilePath(profile, path) {
  return `/p/${checkedProfile(profile)}${path}`
}
export function savedScreenKey(profile) {
  return `last-screen:${checkedProfile(profile)}`
}
export function scopedRequest(request, profile) {
  if (!request || !request.method) return request
  return { ...request, params: { ...request.params, profile: checkedProfile(profile) } }
}
