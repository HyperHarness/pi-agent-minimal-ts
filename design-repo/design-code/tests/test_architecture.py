from pathlib import Path

import gdstk

from pi_chip_design.backends.gdstk_backend import GdstkRenderer
from pi_chip_design.backends.import_metal import import_metal
from pi_chip_design.backends.quantum_metal_backend import QuantumMetalRenderer
from pi_chip_design.core.geometry import Label, PathShape, Rectangle
from pi_chip_design.core.layers import DEFAULT_LAYERS, LayerSpec
from pi_chip_design.templates.ten_qubit import TenQubitSpec, build_ten_qubit_model


def test_ten_qubit_template_builds_backend_independent_model() -> None:
    model = build_ten_qubit_model(TenQubitSpec())

    rectangles = [shape for shape in model.shapes if isinstance(shape, Rectangle)]
    paths = [shape for shape in model.shapes if isinstance(shape, PathShape)]
    labels = [shape for shape in model.shapes if isinstance(shape, Label)]

    assert model.name == "ten_qubit_chip"
    assert len(rectangles) >= 20
    assert len(paths) >= 20
    assert len(labels) == 10
    assert {shape.layer for shape in model.shapes} >= {
        DEFAULT_LAYERS.metal,
        DEFAULT_LAYERS.coupler,
        DEFAULT_LAYERS.readout,
        DEFAULT_LAYERS.control,
    }


def test_gdstk_renderer_writes_model_gds(tmp_path: Path) -> None:
    model = build_ten_qubit_model(TenQubitSpec(qubit_pitch_x=1500.0))
    out = tmp_path / "ten_qubit.gds"

    library = GdstkRenderer().render(model)
    GdstkRenderer().write_gds(model, out)

    top = library.top_level()[0]
    assert isinstance(library, gdstk.Library)
    assert top.name == "ten_qubit_chip"
    assert len(top.polygons) >= 40
    assert out.stat().st_size > 0


def test_quantum_metal_import_is_centralized() -> None:
    metal = import_metal()

    assert metal.__name__ in {"qiskit_metal", "quantum_metal"}


def test_quantum_metal_renderer_writes_model_gds(tmp_path: Path) -> None:
    model = build_ten_qubit_model(TenQubitSpec())
    out = tmp_path / "ten_qubit_quantum_metal.gds"

    QuantumMetalRenderer().write_gds(model, out)

    assert out.stat().st_size > 0


def test_layer_spec_validates_gds_numbers() -> None:
    assert LayerSpec(10, 0).layer == 10

    try:
        LayerSpec(-1, 0)
    except ValueError as exc:
        assert "layer" in str(exc)
    else:
        raise AssertionError("negative layer must fail")
