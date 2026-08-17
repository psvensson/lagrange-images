wit_bindgen::generate!({
    world: "host-reader",
    path: "wit",
});

struct Component;

impl Guest for Component {
    /// Calls straight through to the imported host interface. The guest has no notion of
    /// authority: it either gets a value back or the host call traps.
    fn read_host_value(name: String) -> String {
        crate::lagrange::proof::host_values::read_value(&name)
    }
}

export!(Component);
