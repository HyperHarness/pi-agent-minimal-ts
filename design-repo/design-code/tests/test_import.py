from pathlib import Path

import gdstk

from pi_chip_design import ChipLayout, LayerSpec


def test_package_exports_gdstk_layout_primitives() -> None:
    assert ChipLayout
    assert LayerSpec


def test_chip_layout_writes_basic_gds(tmp_path: Path) -> None:
    metal = LayerSpec(10, 0)
    label = LayerSpec(70, 0)

    layout = ChipLayout("unit_cell")
    layout.add_rectangle("pad", center=(0.0, 0.0), size=(20.0, 10.0), layer=metal)
    layout.add_path("wire", points=[(-10.0, 0.0), (10.0, 0.0), (10.0, 8.0)], width=2.0, layer=metal)
    layout.add_label("Q0", position=(-4.0, 6.0), size=3.0, layer=label)

    library = layout.to_library()
    top = library.top_level()[0]

    assert isinstance(library, gdstk.Library)
    assert top.name == "unit_cell"
    assert len(top.polygons) >= 2
    assert len(top.labels) == 1

    out = tmp_path / "unit_cell.gds"
    layout.write_gds(out)
    assert out.stat().st_size > 0
