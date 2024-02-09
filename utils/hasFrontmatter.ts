export const hasFrontmatter = (content: string, separator: string): boolean => {
  return (
    content.trim().startsWith(separator) && content.split(separator).length > 1
  );
};
