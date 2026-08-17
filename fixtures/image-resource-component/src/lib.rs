wit_bindgen::generate!({
    world: "image-reader",
    path: "wit",
});

use crate::lagrange::proof::image_objects::{self, ItemRecord};

fn render(record: ItemRecord) -> String {
    format!("{}|{}|{}", record.name, record.quantity, record.enabled)
}

struct Component;

impl Guest for Component {
    /// Open, read once, drop at end of scope.
    fn read_once() -> String {
        render(image_objects::open_item().snapshot())
    }

    /// Two reads through one handle, so per-method re-authorization is observable: the second
    /// call must fail on its own merits if authority changed in between.
    fn read_twice() -> String {
        let handle = image_objects::open_item();
        let first = render(handle.snapshot());
        let second = render(handle.snapshot());
        format!("{first}#{second}")
    }

    /// Two handles to the same object. Distinct handle identities, same underlying object.
    fn two_handles() -> String {
        let a = image_objects::open_item();
        let b = image_objects::open_item();
        format!("{}#{}", render(a.snapshot()), render(b.snapshot()))
    }

    /// Dropping one handle must not disturb the other, nor anything durable.
    fn drop_then_use_other() -> String {
        let a = image_objects::open_item();
        let b = image_objects::open_item();
        drop(a);
        render(b.snapshot())
    }

    /// Reads successfully and then traps, so host cleanup on an exceptional exit is testable.
    fn trap_after_read() -> String {
        let handle = image_objects::open_item();
        let _ = handle.snapshot();
        panic!("trapping on purpose after a successful read");
    }
}

export!(Component);
