//! Source navigation extracted from the already compiled document.
use crate::NodeTypstDocument;
use napi_derive::napi;
use reflexo_typst::{EntryReader, TypstDocument, TypstSystemWorld};
use serde::Serialize;
use std::collections::HashMap;
use typst::{
    World,
    layout::{Abs, Frame, FrameItem, Point, Transform},
    syntax::{
        Source, Span, SyntaxKind,
        ast::{self, AstNode},
    },
};

const LIMIT: usize = 200_000;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceRange {
    path: String,
    line: usize,
    column: usize,
    end_line: usize,
    end_column: usize,
}
#[derive(Serialize)]
struct NavigationPoint {
    #[serde(flatten)]
    source: SourceRange,
    page: usize,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

struct Collector<'a> {
    world: &'a TypstSystemWorld,
    cache: HashMap<Span, Option<SourceEntry>>,
    points: Vec<NavigationPoint>,
    exceeded: bool,
}
struct Literal {
    text: String,
    // Decoded UTF-8 byte range -> original source byte range, including escapes.
    characters: Vec<(std::ops::Range<usize>, std::ops::Range<usize>)>,
}
struct SourceEntry {
    path: String,
    source: Source,
    range: std::ops::Range<usize>,
    direct: bool,
    literal: Option<Literal>,
}

fn string_literal(source: &Source, value: ast::Str<'_>) -> Option<Literal> {
    let range = source.find(value.span())?.range();
    let raw = &source.text()[range.start + 1..range.end - 1];
    let mut cursor = 0;
    let mut text = String::new();
    let mut characters = vec![];
    while cursor < raw.len() {
        let start = cursor;
        let mut ch = raw[cursor..].chars().next()?;
        cursor += ch.len_utf8();
        if ch == '\\' {
            ch = raw[cursor..].chars().next()?;
            cursor += ch.len_utf8();
            ch = match ch {
                '\\' => '\\',
                '"' => '"',
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                'u' => {
                    if !raw[cursor..].starts_with('{') {
                        return None;
                    }
                    cursor += 1;
                    let end = cursor + raw[cursor..].find('}')?;
                    let code = u32::from_str_radix(&raw[cursor..end], 16).ok()?;
                    cursor = end + 1;
                    char::from_u32(code)?
                }
                _ => return None,
            };
        }
        let decoded_start = text.len();
        text.push(ch);
        characters.push((
            decoded_start..text.len(),
            range.start + 1 + start..range.start + 1 + cursor,
        ));
    }
    // The compiler's decoder is authoritative. Unknown escapes retain the expression range.
    if text != value.get().as_str() {
        return None;
    }
    Some(Literal { text, characters })
}

fn source_entry(world: &TypstSystemWorld, span: Span) -> Option<SourceEntry> {
    let id = span.id()?;
    let root = world.entry_state().workspace_root()?;
    let resolved = world.path_for_id(id).ok()?.to_err().ok()?;
    let path = resolved
        .strip_prefix(root.as_ref())
        .ok()?
        .to_string_lossy()
        .replace('\\', "/");
    if path.is_empty() || path.starts_with("inputs/") {
        return None;
    }
    let source = world.source(id).ok()?;
    let node = source.find(span)?;
    let range = node.range();
    let direct = matches!(
        node.get().kind(),
        SyntaxKind::Text | SyntaxKind::Space | SyntaxKind::MathText
    );
    let literal = if let Some(value) = node.get().cast::<ast::Str>() {
        string_literal(&source, value)
    } else if let Some(call) = node.get().cast::<ast::FuncCall>() {
        let name = match call.callee() {
            ast::Expr::Ident(id) => id.get().as_str(),
            _ => "",
        };
        if name == "text" || name == "raw" {
            call.args().items().find_map(|arg| {
                let value = match arg {
                    ast::Arg::Pos(ast::Expr::Str(value)) => value,
                    ast::Arg::Named(named)
                        if named.name().get() == "text" || named.name().get() == "body" =>
                    {
                        match named.expr() {
                            ast::Expr::Str(value) => value,
                            _ => return None,
                        }
                    }
                    _ => return None,
                };
                let literal = string_literal(&source, value)?;
                // Raw's preprocessing restarts offsets on each line and expands tabs.
                // Those generated expressions have no unique character-level provenance.
                if name == "raw" && literal.text.contains(['\n', '\r', '\t']) {
                    return None;
                }
                Some(literal)
            })
        } else {
            None
        }
    } else {
        None
    };
    Some(SourceEntry {
        path,
        source,
        range,
        direct,
        literal,
    })
}
fn position(src: &Source, offset: usize) -> (usize, usize) {
    let text = src.text();
    let mut offset = offset.min(text.len());
    while !text.is_char_boundary(offset) {
        offset -= 1;
    }
    let line = src.lines().byte_to_line(offset).unwrap_or(0);
    let start = src.lines().line_to_byte(line).unwrap_or(0);
    (line + 1, text[start..offset].encode_utf16().count() + 1)
}
impl Collector<'_> {
    fn push(
        &mut self,
        span: Span,
        glyph: Option<(usize, &str)>,
        page: usize,
        transform: Transform,
        min: Point,
        max: Point,
    ) {
        if self.exceeded {
            return;
        }
        let world = self.world;
        let entry = self
            .cache
            .entry(span)
            .or_insert_with(|| source_entry(world, span));
        let Some(entry) = entry.as_ref() else {
            return;
        };
        let SourceEntry {
            path,
            source,
            range,
            direct,
            literal,
        } = entry;
        let precise = glyph.and_then(|(off, text)| {
            if let Some(literal) = literal {
                if literal.text.get(off..off + text.len())? != text {
                    return None;
                }
                let first = literal
                    .characters
                    .iter()
                    .find(|(decoded, _)| decoded.start <= off && off < decoded.end)?;
                let last = literal.characters.iter().rev().find(|(decoded, _)| {
                    decoded.start < off + text.len() && off + text.len() <= decoded.end
                })?;
                Some((first.1.start, last.1.end))
            } else if *direct {
                let start = range.start + off;
                let end = start + text.len();
                if end <= range.end && source.text().get(start..end)? == text {
                    Some((start, end))
                } else {
                    None
                }
            } else {
                None
            }
        });
        let (start, end) = precise.unwrap_or((range.start, range.end));
        let (line, column) = position(source, start);
        let (end_line, end_column) = position(source, end);
        let corners = [min, Point::new(max.x, min.y), max, Point::new(min.x, max.y)]
            .map(|p| p.transform(transform));
        let x = corners
            .iter()
            .map(|p| p.x.to_pt())
            .fold(f64::INFINITY, f64::min);
        let y = corners
            .iter()
            .map(|p| p.y.to_pt())
            .fold(f64::INFINITY, f64::min);
        let right = corners
            .iter()
            .map(|p| p.x.to_pt())
            .fold(f64::NEG_INFINITY, f64::max);
        let bottom = corners
            .iter()
            .map(|p| p.y.to_pt())
            .fold(f64::NEG_INFINITY, f64::max);
        if ![x, y, right, bottom].iter().all(|x| x.is_finite()) {
            return;
        }
        if self.points.len() == LIMIT {
            self.exceeded = true;
            return;
        }
        self.points.push(NavigationPoint {
            source: SourceRange {
                path: path.clone(),
                line,
                column,
                end_line,
                end_column,
            },
            page,
            x,
            y,
            width: (right - x).max(0.5),
            height: (bottom - y).max(0.5),
        });
    }
    fn frame(&mut self, frame: &Frame, page: usize, transform: Transform) {
        for (pos, item) in frame.items() {
            if self.exceeded {
                return;
            }
            let t = transform.pre_concat(Transform::translate(pos.x, pos.y));
            match item {
                FrameItem::Group(group) => {
                    self.frame(&group.frame, page, t.pre_concat(group.transform))
                }
                FrameItem::Text(text) => {
                    let mut x = Abs::zero();
                    let mut y = Abs::zero();
                    for glyph in &text.glyphs {
                        let width = glyph.x_advance.at(text.size);
                        let left = x + glyph.x_offset.at(text.size);
                        let baseline = -(y + glyph.y_offset.at(text.size));
                        self.push(
                            glyph.span.0,
                            text.text
                                .get(glyph.range())
                                .map(|value| (glyph.span.1 as usize, value)),
                            page,
                            t,
                            Point::new(left, baseline - text.size),
                            Point::new(left + width, baseline),
                        );
                        x += width;
                        y += glyph.y_advance.at(text.size);
                    }
                }
                FrameItem::Image(_, size, span) => {
                    self.push(*span, None, page, t, Point::zero(), size.to_point())
                }
                FrameItem::Shape(shape, span) => {
                    let bbox = shape.geometry.bbox();
                    self.push(*span, None, page, t, bbox.min, bbox.max);
                }
                _ => {}
            }
        }
    }
}
#[napi]
impl NodeTypstDocument {
    /// Source navigation for this exact compilation, with 1-based UTF-16 source positions.
    #[napi]
    pub fn navigation(&self) -> napi::Result<serde_json::Value> {
        let world = &self.graph.snap.world;
        let mut collector = Collector {
            world,
            cache: HashMap::new(),
            points: vec![],
            exceeded: false,
        };
        if let TypstDocument::Paged(doc) = &self.doc {
            for (page, item) in doc.pages.iter().enumerate() {
                collector.frame(&item.frame, page + 1, Transform::identity());
            }
        }
        if collector.exceeded {
            return Err(napi::Error::from_reason(
                "Source navigation exceeds the 200000 point limit",
            ));
        }
        let mut outline = vec![];
        {
            let headings = reflexo_typst::query::retrieve(world, "heading", &self.doc)
                .map_err(|error| napi::Error::from_reason(error.to_string()))?;
            for heading in headings {
                let Some(location) = heading.location() else {
                    continue;
                };
                let pos = self.doc.introspector().position(location);
                let title = heading
                    .field_by_name("body")
                    .ok()
                    .and_then(|v| v.cast::<typst::foundations::Content>().ok())
                    .map(|c| c.plain_text())
                    .unwrap_or_default();
                let level = heading
                    .to_packed::<typst::model::HeadingElem>()
                    .map(|value| {
                        value
                            .resolve_level(typst::foundations::StyleChain::default())
                            .get()
                    })
                    .unwrap_or(1);
                outline.push(serde_json::json!({"title":title,"level":level,"page":pos.page.get(),"x":pos.point.x.to_pt(),"y":pos.point.y.to_pt()}));
            }
        }
        let pages = match &self.doc {
            TypstDocument::Paged(doc) => doc.pages.iter().enumerate().map(|(index,page)| serde_json::json!({"page":index+1,"width":page.frame.width().to_pt(),"height":page.frame.height().to_pt()})).collect::<Vec<_>>(),
            _ => vec![],
        };
        Ok(serde_json::json!({"points":collector.points,"outline":outline,"pages":pages}))
    }
}
