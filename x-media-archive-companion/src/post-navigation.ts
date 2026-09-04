export interface PostAuthorNavigationOptions {
  profile: boolean;
  folder: boolean;
}

/**
 * Author links are intentionally absent from generated post bodies while the
 * XMC gallery is the primary navigation UI. Keeping their rendering in one
 * pure function makes either link independently reversible without restoring
 * duplicate template literals in ordinary and reply-tree imports.
 */
export const DEFAULT_POST_AUTHOR_NAVIGATION: Readonly<PostAuthorNavigationOptions> = Object.freeze({
  profile: false,
  folder: false,
});

export function postAuthorNavigation(
  root: string,
  folder: string,
  options: Readonly<PostAuthorNavigationOptions> = DEFAULT_POST_AUTHOR_NAVIGATION,
): string {
  const links: string[] = [];
  if (options.profile) links.push(`[[${root}/${folder}/_profile|投稿者プロフィール]]`);
  if (options.folder) links.push(`[[${root}/${folder}/${folder}|このユーザーの投稿フォルダ]]`);
  return links.join(" · ");
}
