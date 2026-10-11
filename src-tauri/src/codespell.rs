//! Spelling in Code Studio: the UI sends a file's text and the parts worth checking — comments in code, the prose of
//! Markdown and plain-text files — as UTF-16 ranges (editor offsets); spell.rs checks them.

use crate::spell::{self, Issue};

/// UTF-16 offset -> byte offset table (one entry per UTF-16 unit, plus the end).
fn byte_offsets(text: &str) -> Vec<usize> {
    let mut out = Vec::with_capacity(text.len() + 1);
    for (i, c) in text.char_indices() { for _ in 0..c.len_utf16() { out.push(i); } }
    out.push(text.len());
    out
}

pub fn to_bytes(text: &str, parts: &[(usize, usize)]) -> Vec<(usize, usize)> {
    let b = byte_offsets(text);
    parts.iter().filter_map(|&(s, e)| Some((*b.get(s)?, *b.get(e)?))).filter(|(s, e)| s < e).collect()
}

#[tauri::command]
pub async fn code_spell(app: tauri::AppHandle, text: String, parts: Vec<(usize, usize)>, lang: String, fallback: String) -> Vec<Issue> {
    spell::check(&app, &text, &to_bytes(&text, &parts), &lang, &fallback)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn utf16_parts() {
        let t = "a😀b // Grüße";
        // "// Grüße" starts at UTF-16 offset 5 (the emoji is two units)
        assert_eq!(to_bytes(t, &[(5, 13)]), [(7, t.len())]);
        assert_eq!(&t[7..], "// Grüße");
        assert!(to_bytes(t, &[(5, 99)]).is_empty());
    }
}
