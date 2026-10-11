//! Fuzzy matching for Search Everywhere: files of the project, symbols and actions.
//! The query's characters must appear in order; whole substrings, consecutive runs and word starts score higher.
//! Positions are character indexes (for highlighting in the UI).

use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::State;

/// The last file list of each project (filled by `walk_files`), so a search doesn't send it back and forth.
#[derive(Default)]
pub struct FileLists(pub Mutex<HashMap<String, Arc<Vec<String>>>>);

/// Not a letter or digit (JS: /[\W_]/).
fn sep(c: char) -> bool { !c.is_ascii_alphanumeric() }

fn lower(c: char) -> char { c.to_lowercase().next().unwrap_or(c) }

/// Score and matched positions of `q` in `s`, or None.
pub fn fuzzy(q: &str, s: &str) -> Option<(f64, Vec<usize>)> {
    if q.is_empty() { return Some((0.0, Vec::new())); }
    let sc: Vec<char> = s.chars().collect();
    let sl: Vec<char> = sc.iter().map(|&c| lower(c)).collect();
    let ql: Vec<char> = q.chars().map(lower).collect();
    let len = sc.len() as f64 * 0.5;
    if let Some(sub) = sl.windows(ql.len()).position(|w| w == ql.as_slice()) {
        let start = sub == 0 || sep(sc[sub - 1]);
        return Some((1000.0 - sub as f64 - len + if start { 200.0 } else { 0.0 }, (sub..sub + ql.len()).collect()));
    }
    let (mut score, mut j, mut prev, mut pos) = (0.0, 0, None, Vec::new());
    for i in 0..sl.len() {
        if j == ql.len() { break; }
        if sl[i] != ql[j] { continue; }
        let start = i == 0 || sep(sc[i - 1]) || (sc[i].is_ascii_uppercase() && sc[i - 1].is_ascii_lowercase());
        score += if prev == Some(i.wrapping_sub(1)) && i > 0 { 15.0 } else { 0.0 } + if start { 25.0 } else { 0.0 } + 1.0;
        pos.push(i);
        prev = Some(i);
        j += 1;
    }
    (j == ql.len()).then(|| (score - len, pos))
}

#[derive(Serialize, Debug, PartialEq)]
pub struct FileHit {
    pub rel: String,
    pub name: String,
    pub dir: String,
    pub name_pos: Vec<usize>,
    pub dir_pos: Vec<usize>,
}

/// A path matches on its file name first (ranked higher), else on the whole relative path.
pub fn match_path(q: &str, rel: &str) -> Option<(f64, FileHit)> {
    let name = &rel[rel.rfind('/').map_or(0, |i| i + 1)..];
    let dir = rel[..rel.len() - name.len()].trim_end_matches('/');
    let hit = |name_pos, dir_pos| FileHit { rel: rel.into(), name: name.into(), dir: dir.into(), name_pos, dir_pos };
    if let Some((score, pos)) = fuzzy(q, name) { return Some((score + 500.0, hit(pos, vec![]))); }
    if !q.contains('/') && q.chars().count() < 3 { return None; }
    let (score, pos) = fuzzy(q, rel)?;
    let off = rel.chars().count() - name.chars().count();
    let name_pos = pos.iter().filter(|&&i| i >= off).map(|&i| i - off).collect();
    let dir_pos = pos.into_iter().filter(|&i| i + 1 < off).collect();
    Some((score, hit(name_pos, dir_pos)))
}

/// The best matching files: by score, then shorter paths first.
pub fn rank_files(q: &str, list: &[String], limit: usize) -> Vec<FileHit> {
    let mut out: Vec<(f64, usize, FileHit)> = list.iter().filter_map(|r| match_path(q, r).map(|(s, h)| (s, r.chars().count(), h))).collect();
    out.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
    out.into_iter().take(limit).map(|x| x.2).collect()
}

/// Ranks names (symbols, actions); `bonus` is added per item (e.g. symbols of the current file). Ties keep their order.
pub fn rank(q: &str, items: &[String], bonus: &[f64], limit: usize) -> Vec<(usize, Vec<usize>)> {
    let mut out: Vec<(f64, usize, Vec<usize>)> = items.iter().enumerate()
        .filter_map(|(i, s)| fuzzy(q, s).map(|(sc, pos)| (sc + bonus.get(i).copied().unwrap_or(0.0), i, pos)))
        .collect();
    out.sort_by(|a, b| b.0.total_cmp(&a.0));
    out.into_iter().take(limit).map(|(_, i, pos)| (i, pos)).collect()
}

#[tauri::command]
pub fn fuzzy_files(lists: State<FileLists>, root: String, q: String, limit: usize) -> Vec<FileHit> {
    let list = lists.0.lock().unwrap().get(&root).cloned().unwrap_or_default();
    rank_files(&q, &list, limit)
}

#[tauri::command]
pub fn fuzzy_rank(q: String, items: Vec<String>, bonus: Vec<f64>, limit: usize) -> Vec<(usize, Vec<usize>)> {
    rank(&q, &items, &bonus, limit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scoring() {
        // Substring at a word start beats one in the middle; shorter strings win ties.
        assert_eq!(fuzzy("main", "main.rs"), Some((1000.0 - 3.5 + 200.0, vec![0, 1, 2, 3])));
        assert_eq!(fuzzy("ain", "main.rs").unwrap().0, 1000.0 - 1.0 - 3.5);
        // Scattered: s (word start 25+1), e (consecutive 15+1), w (1); minus half the length.
        let (s, pos) = fuzzy("sew", "searchEverywhere").unwrap();
        assert_eq!(pos, vec![0, 1, 11]);
        assert_eq!(s, 26.0 + 16.0 + 1.0 - 8.0);
        // A capital after a small letter is a word start: "E" in "searchEverywhere".
        assert_eq!(fuzzy("svy", "searchEverywhere").unwrap().0, 26.0 + 1.0 + 1.0 - 8.0);
        assert_eq!(fuzzy("sev", "searchEverywhere").unwrap().1, vec![0, 1, 7]);
        assert_eq!(fuzzy("xyz", "main.rs"), None);
        assert_eq!(fuzzy("", "x"), Some((0.0, vec![])));
    }

    #[test]
    fn paths_and_ranking() {
        let list: Vec<String> = ["src/main.rs", "ui/app.js", "src-tauri/src/main.rs", "docs/maintenance.md", "ui/lsp.js"].map(String::from).to_vec();
        let hits = rank_files("main", &list, 10);
        assert_eq!(hits.iter().map(|h| h.rel.as_str()).collect::<Vec<_>>(), ["src/main.rs", "src-tauri/src/main.rs", "docs/maintenance.md"]);
        assert_eq!((hits[0].name.as_str(), hits[0].dir.as_str(), hits[0].name_pos.clone()), ("main.rs", "src", vec![0, 1, 2, 3]));
        // Matching across the path: positions are split into folder and name.
        let (_, h) = match_path("uiapp", "ui/app.js").unwrap();
        assert_eq!((h.dir_pos, h.name_pos), (vec![0, 1], vec![0, 1, 2]));
        assert!(match_path("ua", "ui/lsp.js").is_none()); // short queries only match file names
        let r = rank("ap", &["Open".into(), "app".into(), "Map".into()], &[0.0, 0.0, 300.0], 10);
        assert_eq!(r.iter().map(|x| x.0).collect::<Vec<_>>(), [2, 1]);
    }
}

/// Parity check: FZ_LIST (one path per line) ranked for each query in FZ_QUERIES; JSON written to FZ_OUT.
#[cfg(test)]
#[test]
#[ignore]
fn dump_for_comparison() {
    let read = |k: &str| std::fs::read_to_string(std::env::var(k).unwrap()).unwrap();
    let list: Vec<String> = read("FZ_LIST").lines().map(String::from).collect();
    let mut all = serde_json::Map::new();
    for q in read("FZ_QUERIES").lines() {
        let hits = rank_files(q, &list, 60);
        all.insert(q.into(), serde_json::to_value(&hits).unwrap());
    }
    std::fs::write(std::env::var("FZ_OUT").unwrap(), serde_json::to_string(&all).unwrap()).unwrap();
}
