//! Live templates (P-006): abbreviation + Tab, postfix completion (`expr.if`) and Surround With (Ctrl+Alt+T).
//! Built-in sets live in `templates/builtin.json`; the user's own templates — and changed or switched-off built-ins —
//! in one small JSON file in the Studio data folder (`Studio/code-templates.json`), which can be exported and imported.
//! Bodies use Monaco's snippet syntax; `$EXPR` (postfix) and `$SELECTION` (surround) are filled in here.

use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fs, path::PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Template {
    /// Monaco language id, or "*" for every language
    pub lang: String,
    /// "live", "postfix" or "surround"
    pub kind: String,
    pub abbr: String,
    #[serde(default)]
    pub desc: String,
    pub body: String,
    /// shipped with the app (possibly changed by the user)
    #[serde(default, skip_deserializing)]
    pub builtin: bool,
    /// a built-in the user has changed
    #[serde(default, skip_deserializing)]
    pub changed: bool,
    #[serde(default = "yes", skip_deserializing)]
    pub enabled: bool,
}

fn yes() -> bool { true }

/// The file in the data folder (and the export format).
#[derive(Serialize, Deserialize, Default, Debug)]
struct UserFile {
    #[serde(default)]
    app: String,
    #[serde(default)]
    version: u32,
    #[serde(default)]
    templates: Vec<Template>,
    /// keys ("lang/kind/abbr") of switched-off templates
    #[serde(default)]
    disabled: Vec<String>,
}

const KINDS: [&str; 3] = ["live", "postfix", "surround"];

pub fn key(lang: &str, kind: &str, abbr: &str) -> String { format!("{lang}/{kind}/{abbr}") }
fn key_of(t: &Template) -> String { key(&t.lang, &t.kind, &t.abbr) }

/// The shipped templates, descriptions in the UI language ("en" / "de").
fn builtin(ui_lang: &str) -> Vec<Template> {
    let json: serde_json::Value = serde_json::from_str(include_str!("../templates/builtin.json")).unwrap_or_default();
    let mut out = Vec::new();
    let Some(map) = json.as_object() else { return out };
    for (langs, list) in map {
        if langs.starts_with('_') { continue; }
        for row in list.as_array().into_iter().flatten() {
            let s = |i: usize| row.get(i).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let desc = s(2);
            let desc = match desc.split_once('|') { Some((en, de)) => if ui_lang == "de" { de } else { en }.to_string(), None => desc };
            for lang in langs.split(',') {
                out.push(Template { lang: lang.trim().into(), kind: s(0), abbr: s(1), desc: desc.clone(), body: s(3), builtin: true, changed: false, enabled: true });
            }
        }
    }
    out
}

/// Built-ins with the user's changes, then the user's own templates.
fn merged(user: &UserFile, ui_lang: &str) -> Vec<Template> {
    let off: HashSet<&str> = user.disabled.iter().map(String::as_str).collect();
    let mut out = builtin(ui_lang);
    let base: HashSet<String> = out.iter().map(key_of).collect();
    for t in &mut out {
        if let Some(u) = user.templates.iter().find(|u| key_of(u) == key_of(t)) {
            t.desc = u.desc.clone();
            t.body = u.body.clone();
            t.changed = true;
        }
    }
    out.extend(user.templates.iter().filter(|u| !base.contains(&key_of(u))).cloned().map(|mut u| { u.builtin = false; u.changed = false; u }));
    for t in &mut out { t.enabled = !off.contains(key_of(t).as_str()); }
    out
}

fn user_path(app: &AppHandle) -> Option<PathBuf> { app.path().data_dir().ok().map(|d| d.join("Studio").join("code-templates.json")) }

fn read_user(app: &AppHandle) -> UserFile {
    user_path(app).and_then(|p| fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn write_user(app: &AppHandle, mut user: UserFile) -> Result<(), String> {
    let p = user_path(app).ok_or("no data folder")?;
    if let Some(dir) = p.parent() { fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
    user.app = "Code Studio".into();
    user.version = 1;
    user.disabled.sort();
    user.disabled.dedup();
    fs::write(&p, serde_json::to_string_pretty(&user).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// Checks a template; the error is a text key of the UI.
fn validate(t: &Template) -> Result<(), &'static str> {
    if t.abbr.is_empty() || t.abbr.chars().any(|c| !(c.is_alphanumeric() || c == '_' || c == '-' || c == '!' || c == ':')) { return Err("tpl.err.abbr"); }
    if t.lang.trim().is_empty() { return Err("tpl.err.lang"); }
    if !KINDS.contains(&t.kind.as_str()) { return Err("tpl.err.kind"); }
    if t.body.trim().is_empty() { return Err("tpl.err.body"); }
    if t.kind == "postfix" && !t.body.contains("$EXPR") { return Err("tpl.err.expr"); }
    if t.kind == "surround" && !t.body.contains("$SELECTION") { return Err("tpl.err.selection"); }
    Ok(())
}

/// Saves a template (`old` = its key before editing, to rename it). Built-ins are stored as a change.
fn save_into(user: &mut UserFile, old: Option<&str>, mut t: Template) -> Result<(), &'static str> {
    t.abbr = t.abbr.trim().into();
    t.lang = t.lang.trim().into();
    t.desc = t.desc.trim().into();
    validate(&t)?;
    let new_key = key_of(&t);
    if let Some(old) = old {
        if old != new_key { user.templates.retain(|u| key_of(u) != old); }
    }
    let is_new = old.map_or(true, |o| o != new_key);
    if is_new && user.templates.iter().any(|u| key_of(u) == new_key) { return Err("tpl.err.exists"); }
    user.templates.retain(|u| key_of(u) != new_key);
    user.templates.push(Template { builtin: false, changed: false, enabled: true, ..t });
    Ok(())
}

/* ---------- Filling in $EXPR / $SELECTION ---------- */

/// Text taken over into a snippet literally.
fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '\\' | '$' | '}') { out.push('\\'); }
        out.push(c);
    }
    out
}

/// Removes the indentation all non-empty lines share.
fn dedent(s: &str) -> String {
    let lines: Vec<&str> = s.split('\n').collect();
    let common = lines.iter().filter(|l| !l.trim().is_empty())
        .map(|l| l.len() - l.trim_start_matches([' ', '\t']).len()).min().unwrap_or(0);
    lines.iter().map(|l| if l.len() >= common { &l[common..] } else { l.trim_start() }).collect::<Vec<_>>().join("\n")
}

/// Puts `value` for `placeholder` into `body`; lines after the first get the indentation the placeholder has in the body.
fn fill(body: &str, placeholder: &str, value: &str) -> String {
    let value = escape(value.trim_end_matches(['\n', '\r']));
    let mut out = String::new();
    let mut rest = body;
    while let Some(i) = rest.find(placeholder) {
        let before = &rest[..i];
        out.push_str(before);
        let line_start = out.rfind('\n').map_or(0, |n| n + 1);
        let prefix: String = out[line_start..].chars().take_while(|c| *c == ' ' || *c == '\t').collect();
        out.push_str(&value.replace('\n', &format!("\n{prefix}")));
        rest = &rest[i + placeholder.len()..];
    }
    out.push_str(rest);
    out
}

/* ---------- Postfix: the expression before ".abbr" ---------- */

fn ident(c: char) -> bool { c.is_alphanumeric() || c == '_' || c == '$' }

/// Where the expression before the last `.word` of `line` (the text before the cursor) starts:
/// (start in UTF-16 units = Monaco column - 1, the expression, the abbreviation typed so far).
pub fn postfix_target(line: &str) -> Option<(usize, String, String)> {
    let c: Vec<char> = line.chars().collect();
    let mut d = c.len();
    while d > 0 && ident(c[d - 1]) { d -= 1; }
    if d == 0 || c[d - 1] != '.' { return None; }
    let typed: String = c[d..].iter().collect();
    if typed.chars().next().is_some_and(|ch| ch.is_ascii_digit()) { return None; }
    let dot = d - 1;
    let mut i = dot;
    // Walks back over identifiers, calls, indexing, strings and the connectors . :: -> ? !
    loop {
        if i == 0 { break; }
        let ch = c[i - 1];
        if ident(ch) {
            while i > 0 && ident(c[i - 1]) { i -= 1; }
        } else if matches!(ch, ')' | ']' | '}') {
            i = group_start(&c, i)?;
        } else if matches!(ch, '"' | '\'' | '`') {
            i = string_start(&c, i)?;
        } else if ch == '?' || ch == '!' {
            i -= 1;
            continue;
        } else {
            break;
        }
        // A connector before this part continues the expression.
        if i >= 1 && c[i - 1] == '.' && i >= 2 && !c[i - 2].is_whitespace() { i -= 1; continue; }
        if i >= 2 && c[i - 1] == ':' && c[i - 2] == ':' { i -= 2; continue; }
        if i >= 2 && c[i - 1] == '>' && c[i - 2] == '-' { i -= 2; continue; }
        if i >= 1 && (c[i - 1] == '!' || c[i - 1] == '?') && i >= 2 && ident(c[i - 2]) { i -= 1; continue; }
        if i >= 1 && (matches!(c[i - 1], ')' | ']') || (ident(c[i - 1]) && matches!(c.get(i), Some('(' | '[' | '!')))) { continue; }
        break;
    }
    let expr: String = c[i..dot].iter().collect();
    if !expr.chars().any(|ch| ident(ch) || matches!(ch, ')' | ']' | '"' | '\'' | '`')) { return None; }
    // Only digits ("3.") is a number being typed, not an expression.
    if expr.chars().all(|ch| ch.is_ascii_digit()) { return None; }
    let start = c[..i].iter().map(|ch| ch.len_utf16()).sum();
    Some((start, expr, typed))
}

/// Start of the bracket group that ends just before `end`.
fn group_start(c: &[char], end: usize) -> Option<usize> {
    let mut stack = Vec::new();
    let mut i = end;
    while i > 0 {
        let ch = c[i - 1];
        match ch {
            ')' | ']' | '}' => { stack.push(ch); i -= 1; }
            '(' | '[' | '{' => {
                let want = match ch { '(' => ')', '[' => ']', _ => '}' };
                if stack.pop() != Some(want) { return None; }
                i -= 1;
                if stack.is_empty() { return Some(i); }
            }
            '"' | '\'' | '`' => { i = string_start(c, i)?; }
            _ => i -= 1,
        }
    }
    None
}

/// Start of the string literal whose closing quote is just before `end`.
fn string_start(c: &[char], end: usize) -> Option<usize> {
    let q = c[end - 1];
    let mut i = end - 1;
    while i > 0 {
        i -= 1;
        if c[i] == q {
            let mut slashes = 0;
            while i > slashes && c[i - 1 - slashes] == '\\' { slashes += 1; }
            if slashes % 2 == 0 { return Some(i); }
        }
    }
    None
}

/* ---------- Commands ---------- */

#[tauri::command]
pub fn templates_list(app: AppHandle, ui_lang: String) -> Vec<Template> { merged(&read_user(&app), &ui_lang) }

#[tauri::command]
pub fn template_save(app: AppHandle, old: Option<String>, template: Template) -> Result<(), String> {
    let mut user = read_user(&app);
    save_into(&mut user, old.as_deref(), template).map_err(String::from)?;
    write_user(&app, user)
}

/// Deletes an own template, or undoes the changes to a built-in one.
#[tauri::command]
pub fn template_delete(app: AppHandle, key: String) -> Result<(), String> {
    let mut user = read_user(&app);
    user.templates.retain(|u| key_of(u) != key);
    user.disabled.retain(|k| *k != key);
    write_user(&app, user)
}

#[tauri::command]
pub fn template_enable(app: AppHandle, key: String, on: bool) -> Result<(), String> {
    let mut user = read_user(&app);
    user.disabled.retain(|k| *k != key);
    if !on { user.disabled.push(key); }
    write_user(&app, user)
}

/// Writes the user's templates (own, changed and switched-off ones) to a file to take to another PC.
#[tauri::command]
pub fn templates_export(app: AppHandle, path: String) -> Result<usize, String> {
    let user = read_user(&app);
    let n = user.templates.len();
    let mut copy = UserFile { templates: user.templates, disabled: user.disabled, ..Default::default() };
    copy.app = "Code Studio".into();
    copy.version = 1;
    fs::write(&path, serde_json::to_string_pretty(&copy).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(n)
}

/// Adds the templates of an exported file (same abbreviation = replaced). Returns how many were taken over.
#[tauri::command]
pub fn templates_import(app: AppHandle, path: String) -> Result<usize, String> {
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let file: UserFile = serde_json::from_str(&text).map_err(|_| "tpl.err.file".to_string())?;
    let mut user = read_user(&app);
    let mut n = 0;
    for t in file.templates {
        if validate(&t).is_err() { continue; }
        let k = key_of(&t);
        user.templates.retain(|u| key_of(u) != k);
        user.templates.push(t);
        n += 1;
    }
    user.disabled.extend(file.disabled);
    write_user(&app, user)?;
    Ok(n)
}

#[derive(Serialize)]
pub struct Postfix { start: usize, expr: String, typed: String }

#[tauri::command]
pub fn template_postfix(line: String) -> Option<Postfix> {
    postfix_target(&line).map(|(start, expr, typed)| Postfix { start, expr, typed })
}

/// The snippet text for a template: `$EXPR` or `$SELECTION` replaced by `text`
/// (a selection of whole lines loses its common indentation first).
#[tauri::command]
pub fn template_fill(body: String, text: String, kind: String, lines: bool) -> String {
    match kind.as_str() {
        "postfix" => fill(&body, "$EXPR", &text),
        _ => fill(&body, "$SELECTION", &if lines { dedent(&text) } else { text }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(line: &str) -> Option<(usize, String)> { postfix_target(line).map(|(s, e, _)| (s, e)) }

    #[test]
    fn builtin_sets_load() {
        let all = builtin("en");
        assert!(all.len() > 100);
        for t in &all { assert!(validate(t).is_ok(), "{} {}", key_of(t), t.body); }
        assert!(all.iter().any(|t| t.lang == "typescript" && t.kind == "postfix" && t.abbr == "log"));
        assert!(all.iter().any(|t| t.lang == "cpp" && t.abbr == "forr"));
        assert!(all.iter().any(|t| t.lang == "cpp" && t.abbr == "main"));
        let de = builtin("de");
        assert_eq!(de.iter().find(|t| t.lang == "rust" && t.abbr == "fn").unwrap().desc, "Funktion");
        // no two templates with the same key
        let keys: HashSet<String> = all.iter().map(key_of).collect();
        assert_eq!(keys.len(), all.len());
    }

    #[test]
    fn user_changes_merge() {
        let mut user = UserFile::default();
        let fn_key = key("rust", "live", "fn");
        let mut t = builtin("en").into_iter().find(|t| key_of(t) == fn_key).unwrap();
        t.body = "fn ${1:x}() {}".into();
        save_into(&mut user, Some(&fn_key), t).unwrap();
        save_into(&mut user, None, Template { lang: "rust".into(), kind: "live".into(), abbr: "hello".into(), desc: "Hi".into(),
            body: "println!(\"hi\");".into(), builtin: true, changed: true, enabled: true }).unwrap();
        user.disabled.push(key("rust", "live", "for"));
        let m = merged(&user, "en");
        let f = m.iter().find(|t| key_of(t) == fn_key).unwrap();
        assert!(f.builtin && f.changed && f.body == "fn ${1:x}() {}");
        let h = m.iter().find(|t| t.abbr == "hello").unwrap();
        assert!(!h.builtin && !h.changed && h.enabled);
        assert!(!m.iter().find(|t| key_of(t) == key("rust", "live", "for")).unwrap().enabled);
        assert_eq!(m.iter().filter(|t| key_of(t) == fn_key).count(), 1);
        // a new template may not take an existing own abbreviation; renaming moves it
        let dup = Template { lang: "rust".into(), kind: "live".into(), abbr: "hello".into(), desc: String::new(), body: "x".into(), builtin: false, changed: false, enabled: true };
        assert_eq!(save_into(&mut user, None, dup.clone()), Err("tpl.err.exists"));
        save_into(&mut user, Some(&key("rust", "live", "hello")), Template { abbr: "hi".into(), ..dup }).unwrap();
        assert!(user.templates.iter().any(|t| t.abbr == "hi") && !user.templates.iter().any(|t| t.abbr == "hello"));
    }

    #[test]
    fn validation() {
        let t = |kind: &str, abbr: &str, body: &str| Template { lang: "rust".into(), kind: kind.into(), abbr: abbr.into(), desc: String::new(), body: body.into(), builtin: false, changed: false, enabled: true };
        assert!(validate(&t("live", "fn", "fn")).is_ok());
        assert_eq!(validate(&t("live", "a b", "x")), Err("tpl.err.abbr"));
        assert_eq!(validate(&t("live", "", "x")), Err("tpl.err.abbr"));
        assert_eq!(validate(&t("postfix", "x", "dbg!()")), Err("tpl.err.expr"));
        assert_eq!(validate(&t("surround", "x", "{ }")), Err("tpl.err.selection"));
        assert_eq!(validate(&t("other", "x", "y")), Err("tpl.err.kind"));
        assert_eq!(validate(&t("live", "x", "  ")), Err("tpl.err.body"));
    }

    #[test]
    fn postfix_expressions() {
        assert_eq!(target("    value.if"), Some((4, "value".into())));
        assert_eq!(target("let a = x.y.z.dbg"), Some((8, "x.y.z".into())));
        assert_eq!(target("foo(1, bar(2)).not"), Some((0, "foo(1, bar(2))".into())));
        assert_eq!(target("items.iter().map(|x| x + 1)."), Some((0, "items.iter().map(|x| x + 1)".into())));
        assert_eq!(target("vec![1, 2].for"), Some((0, "vec![1, 2]".into())));
        assert_eq!(target("std::env::args().for"), Some((0, "std::env::args()".into())));
        assert_eq!(target("read()?.ok"), Some((0, "read()?".into())));
        assert_eq!(target("x = \"a.b(\".len"), Some((4, "\"a.b(\"".into())));
        assert_eq!(target("return a[i].log"), Some((7, "a[i]".into())));
        assert_eq!(target("$this->name.if"), Some((0, "$this->name".into())));
        assert_eq!(target("!done.if"), Some((1, "done".into())));
        assert_eq!(target("größe.if"), Some((0, "größe".into())));
        assert_eq!(target("😀 = x.if"), Some((5, "x".into())), "start counted in UTF-16 units");
        assert_eq!(target("x.if").map(|_| postfix_target("x.if").unwrap().2), Some("if".into()));
        assert_eq!(target("a + "), None);
        assert_eq!(target(" .if"), None);
        assert_eq!(target("3."), None);
        assert_eq!(target("x.5"), None);
        assert_eq!(target("unbalanced).if"), None);
    }

    #[test]
    fn filling() {
        assert_eq!(fill("dbg!($EXPR)", "$EXPR", "a$b}"), "dbg!(a\\$b\\})");
        assert_eq!(fill("if c {\n\t$SELECTION\n}$0", "$SELECTION", "a();\nb();\n"), "if c {\n\ta();\n\tb();\n}$0");
        assert_eq!(dedent("    a\n      b\n\n    c"), "a\n  b\n\nc");
        assert_eq!(template_fill("{\n\t$SELECTION\n}".into(), "  x\n  y".into(), "surround".into(), true), "{\n\tx\n\ty\n}");
        assert_eq!(template_fill("**$SELECTION**".into(), "  word".into(), "surround".into(), false), "**  word**");
        assert_eq!(fill("$SELECTION / $SELECTION", "$SELECTION", "a"), "a / a");
    }
}
