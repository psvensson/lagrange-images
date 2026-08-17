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
}

export!(Component);
