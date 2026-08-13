export function isValidArtworkType(contentType) {
  const allowed = ['image/jpeg', 'image/png', 'application/pdf'];
  return allowed.includes(contentType);
}
