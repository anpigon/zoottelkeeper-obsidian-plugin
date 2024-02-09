import { hasFrontmatter } from "./hasFrontmatter";

export const getFrontmatter = (content: string, separator: string): string => {
  return hasFrontmatter(content, separator)
    ? `${separator}${content.split(separator)[1]}${separator}`
    : "";
};
