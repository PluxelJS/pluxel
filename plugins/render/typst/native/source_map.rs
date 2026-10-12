//! Source navigation extracted from the already compiled document.
use crate::NodeTypstDocument;
use napi_derive::napi;
use reflexo_typst::{EntryReader, TypstDocument, TypstSystemWorld};
use serde::Serialize;
use std::collections::HashMap;
use typst::{
    layout::{Abs, Frame, FrameItem, Point, Transform},
    syntax::{Source, Span},
    World,
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
    cache: HashMap<Span, Option<(String, Source, std::ops::Range<usize>)>>,
    points: Vec<NavigationPoint>,
    exceeded: bool,
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
        offset: Option<(usize, usize)>,
        page: usize,
        transform: Transform,
        min: Point,
        max: Point,
    ) {
        if self.exceeded {
            return;
        }
        let world = self.world;
        let entry = self.cache.entry(span).or_insert_with(|| {
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
            let range = source.find(span)?.range();
            Some((path, source, range))
        });
        let Some((path, source, range)) = entry.as_ref() else {
            return;
        };
        let (start, end) = offset
            .map(|(off, len)| {
                let start = (range.start + off).min(range.end);
                (start, (start + len).min(range.end))
            })
            .unwrap_or((range.start, range.end));
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
                            Some((glyph.span.1 as usize, glyph.range().len())),
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
