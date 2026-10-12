//! Bounded PNG rasterization of an existing compiled page.
use crate::NodeTypstDocument;
use napi::{bindgen_prelude::Buffer, Error, Result};
use napi_derive::napi;
use reflexo_typst::TypstDocument;

#[napi(object)]
pub struct PageRegion {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[napi(object)]
pub struct RenderedPage {
    pub data: Buffer,
    pub width: u32,
    pub height: u32,
    pub region: PageRegion,
}

#[napi]
impl NodeTypstDocument {
    /// Render this document without evaluation or compilation. Crop after rasterization
    /// preserves the original page-relative backgrounds, gradients and clipping.
    #[napi]
    pub fn render_page(
        &self,
        page: u32,
        scale: f64,
        region: Option<PageRegion>,
        max_bytes: f64,
    ) -> Result<RenderedPage> {
        let TypstDocument::Paged(doc) = &self.doc else {
            return Err(Error::from_reason("Expected a paged document"));
        };
        let page = page
            .checked_sub(1)
            .and_then(|index| doc.pages.get(index as usize))
            .ok_or_else(|| Error::from_reason("Page number is out of bounds"))?;
        if !scale.is_finite() || scale <= 0.0 || (scale as f32) <= 0.0 || scale > 8.0 {
            return Err(Error::from_reason("Scale must be finite and in (0, 8]"));
        }
        let size = page.frame.size();
        let page_width = size.x.to_pt();
        let page_height = size.y.to_pt();
        let scale = scale as f32;
        let px_width = (scale * (size.x.to_pt() as f32)).round().max(1.0) as f64;
        let px_height = (scale * (size.y.to_pt() as f32)).round().max(1.0) as f64;
        if !px_width.is_finite()
            || !px_height.is_finite()
            || px_width > 8192.0
            || px_height > 8192.0
            || px_width * px_height > 16_000_000.0
        {
            return Err(Error::from_reason(
                "Page raster exceeds 8192 pixels per side or 16000000 pixels; reduce scale",
            ));
        }
        let region = region.unwrap_or(PageRegion {
            x: 0.0,
            y: 0.0,
            width: page_width,
            height: page_height,
        });
        if ![region.x, region.y, region.width, region.height]
            .iter()
            .all(|v| v.is_finite())
            || region.x < 0.0
            || region.y < 0.0
            || region.width <= 0.0
            || region.height <= 0.0
            || region.x + region.width > page_width
            || region.y + region.height > page_height
        {
            return Err(Error::from_reason(
                "Region must be a finite positive rectangle inside the page",
            ));
        }
        let factor = scale as f64;
        let left = (region.x * factor).floor().min(px_width - 1.0) as u32;
        let top = (region.y * factor).floor().min(px_height - 1.0) as u32;
        let right = ((region.x + region.width) * factor).ceil().min(px_width) as u32;
        let bottom = ((region.y + region.height) * factor).ceil().min(px_height) as u32;
        let bitmap = typst_render::render(page, scale);
        let rectangle =
            tiny_skia::IntRect::from_xywh(left as i32, top as i32, right - left, bottom - top)
                .ok_or_else(|| Error::from_reason("Region has no raster pixels"))?;
        let cropped =
            if left == 0 && top == 0 && right == bitmap.width() && bottom == bitmap.height() {
                bitmap
            } else {
                bitmap
                    .clone_rect(rectangle)
                    .ok_or_else(|| Error::from_reason("Region has no raster pixels"))?
            };
        let bytes = cropped
            .encode_png()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        if bytes.len() > max_bytes as usize {
            return Err(Error::from_reason(
                "PNG exceeds configured output byte limit",
            ));
        }
        Ok(RenderedPage {
            data: Buffer::from(bytes),
            width: cropped.width(),
            height: cropped.height(),
            region: PageRegion {
                x: left as f64 / factor,
                y: top as f64 / factor,
                width: (right - left) as f64 / factor,
                height: (bottom - top) as f64 / factor,
            },
        })
    }
}
