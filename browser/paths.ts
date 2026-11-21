export function compactProjectPath(
  path: string,
  fits: (text: string) => boolean,
) {
  if (fits(path)) return path;
  const directories = path.split("/").filter(Boolean);
  for (let start = 1; start < directories.length; start++) {
    const candidate = `../${directories.slice(start).join("/")}`;
    if (fits(candidate) || start === directories.length - 1) return candidate;
  }
  return path;
}
