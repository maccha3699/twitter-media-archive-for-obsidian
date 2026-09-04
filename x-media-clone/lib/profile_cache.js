function merge(previous, incoming) {
  const left = previous && typeof previous === "object" ? previous : {};
  const right = incoming && typeof incoming === "object" ? incoming : {};
  return {
    id: right.id ?? left.id ?? null,
    screenName: right.screenName ?? left.screenName ?? null,
    displayName: right.displayName ?? left.displayName ?? null,
    bio: right.bio ?? left.bio ?? null,
    urls: [...new Set([...(Array.isArray(left.urls) ? left.urls : []), ...(Array.isArray(right.urls) ? right.urls : [])])],
    location: right.location ?? left.location ?? null,
    followers: right.followers ?? left.followers ?? null,
    metadataStatus: left.metadataStatus === "observed" || right.metadataStatus === "observed" ? "observed" : "profile-pending",
  };
}

export class ProfileCache {
  constructor(limit = 500) { this.limit = limit; this.byId = new Map(); this.byScreen = new Map(); }
  put(profile) {
    if (!profile || typeof profile !== "object") return;
    const screen = typeof profile.screenName === "string" ? profile.screenName.toLowerCase() : null;
    const previous = (profile.id && this.byId.get(profile.id)) || (screen && this.byScreen.get(screen)) || null;
    const value = merge(previous, profile);
    if (value.id) this.byId.set(value.id, value);
    if (value.screenName) this.byScreen.set(value.screenName.toLowerCase(), value);
    while (this.byScreen.size > this.limit) this.byScreen.delete(this.byScreen.keys().next().value);
    while (this.byId.size > this.limit) this.byId.delete(this.byId.keys().next().value);
  }
  enrich(tweet) {
    const author = tweet?.author && typeof tweet.author === "object" ? tweet.author : {};
    const screen = author.screenName || tweet?.authorScreenName;
    const cached = (author.id && this.byId.get(author.id)) || (typeof screen === "string" && this.byScreen.get(screen.toLowerCase())) || null;
    const merged = merge(author, cached);
    return { ...tweet, author: merged, authorScreenName: merged.screenName || tweet?.authorScreenName || "unknown", profileMetadataStatus: merged.metadataStatus };
  }
}
