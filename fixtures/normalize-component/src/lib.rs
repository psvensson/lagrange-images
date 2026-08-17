use std::sync::atomic::{AtomicI64, Ordering};

/// Mutable guest state. Its only purpose is to make instance reuse observable: if an
/// instance is reused across activations this keeps counting, and if each activation gets a
/// fresh instance it always answers 1.
static COUNTER: AtomicI64 = AtomicI64::new(0);

wit_bindgen::generate!({
    world: "normalize",
    path: "wit",
});

struct Component;

impl Guest for Component {
    /// normalize/v1: lowercase, collapse each ASCII whitespace run to one space, trim.
    fn normalize(input: String) -> String {
        let mut out = String::with_capacity(input.len());
        let mut pending_space = false;
        for ch in input.chars() {
            if matches!(ch, ' ' | '\t' | '\n' | '\u{b}' | '\u{c}' | '\r') {
                if !out.is_empty() {
                    pending_space = true;
                }
            } else {
                if pending_space {
                    out.push(' ');
                }
                pending_space = false;
                out.extend(ch.to_lowercase());
            }
        }
        out
    }

    /// Reverses the byte sequence. Chosen because it cannot succeed unless every byte
    /// value and its position survived the boundary.
    fn reverse(data: Vec<u8>) -> Vec<u8> {
        let mut out = data;
        out.reverse();
        out
    }

    /// IEEE 754 double multiplication, which is exactly specified, so any disagreement
    /// between lanes is a boundary bug rather than a rounding difference.
    fn scale(value: f64, factor: f64) -> f64 {
        value * factor
    }

    /// Applies normalize to every element. The list is the point: arbitrary length,
    /// variable-length elements, Unicode, empty strings and empty lists all have to survive.
    fn normalize_all(values: Vec<String>) -> Vec<String> {
        values.into_iter().map(Self::normalize).collect()
    }

    /// Normalizes the name and flips the flag. Quantity passes through untouched on
    /// purpose, so s64 extremes are proven without arithmetic that could overflow
    /// differently in Rust than in Smalltalk.
    fn relabel(it: Item) -> Item {
        Item {
            name: Self::normalize(it.name),
            quantity: it.quantity,
            enabled: !it.enabled,
        }
    }

    /// Increments guest-resident state and returns the new value. See COUNTER.
    fn bump() -> i64 {
        COUNTER.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// relabel over a list, so a list whose elements are records is exercised in both
    /// directions through the same recursion the codec uses.
    fn relabel_all(items: Vec<Item>) -> Vec<Item> {
        items.into_iter().map(Self::relabel).collect()
    }

    /// Builds a record from scalars, so a record result is proven independently of a
    /// record argument.
    fn make_item(name: String, quantity: i64) -> Item {
        Item {
            name: Self::normalize(name),
            quantity,
            enabled: quantity > 0,
        }
    }

    /// Returns its argument. The interesting part is the f32 parameter: the value has
    /// already been rounded to f32 precision by the shared interface, so this proves
    /// the rounding happened before the lane rather than inside it.
    fn echo_f32(value: f32) -> f32 {
        value
    }
}

export!(Component);
