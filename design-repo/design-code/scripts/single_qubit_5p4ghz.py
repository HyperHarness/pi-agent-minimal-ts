from pathlib import Path

from pi_chip_design.layout import ChipLayout
from pi_chip_design.core.layers import DEFAULT_LAYERS as L

# Concept-level fixed-frequency transmon layout and analytical frequency check.
# Units in the GDS are micrometers. The simulation below is a lumped-element
# transmon estimate, not an EM/HFSS/Q3D extraction.

h = 6.62607015e-34
hbar = 1.054571817e-34
e = 1.602176634e-19
phi0 = h / (2 * e)

target_f01 = 5.4e9
EC_over_h = 0.260e9  # typical transmon-scale charging energy assumption
EJ_over_h = ((target_f01 + EC_over_h) ** 2) / (8 * EC_over_h)
C_total = e**2 / (2 * h * EC_over_h)
Ic = 2 * 3.141592653589793 * EJ_over_h * hbar / phi0
EJ_EC = EJ_over_h / EC_over_h
anharm = -EC_over_h

layout = ChipLayout("SINGLE_TRANSMON_5P4GHZ")
layout.add_rectangle("chip", center=(0, 0), size=(4000, 3000), layer=L.chip)
layout.add_rectangle("ground", center=(0, 0), size=(3600, 2600), layer=L.ground)
layout.add_rectangle("left_paddle", center=(-115, 0), size=(180, 520), layer=L.metal)
layout.add_rectangle("right_paddle", center=(115, 0), size=(180, 520), layer=L.metal)
layout.add_rectangle("top_arm", center=(0, 230), size=(70, 260), layer=L.metal)
layout.add_rectangle("bottom_arm", center=(0, -230), size=(70, 260), layer=L.metal)
layout.add_rectangle("jj_left_lead", center=(-18, 0), size=(34, 8), layer=L.coupler)
layout.add_rectangle("jj_right_lead", center=(18, 0), size=(34, 8), layer=L.coupler)
layout.add_rectangle("jj_barrier_symbol", center=(0, 0), size=(4, 26), layer=L.marker)
layout.add_path("readout_resonator", points=[(360, 360), (900, 360), (900, 120), (520, 120)], width=18, layer=L.readout)
layout.add_path("xy_control", points=[(-900, -380), (-350, -380), (-350, -120)], width=12, layer=L.control)
layout.add_path("flux_or_marker_line", points=[(900, -380), (350, -380), (350, -120)], width=10, layer=L.control)
label = (
    "single transmon target f01=5.400 GHz; "
    f"EC/h={EC_over_h/1e9:.3f} GHz; EJ/h={EJ_over_h/1e9:.2f} GHz; "
    f"EJ/EC={EJ_EC:.1f}; C={C_total*1e15:.1f} fF; Ic={Ic*1e9:.1f} nA"
)
layout.add_label(label, position=(-1750, -1350), size=40, layer=L.label)

candidates = [Path("outputs/single_transmon_5p4ghz.gds"), Path("design-repo/design-code/outputs/single_transmon_5p4ghz.gds")]
written = []
for out in candidates:
    try:
        layout.write_gds(out)
        written.append(str(out))
    except Exception as exc:
        print(f"Could not write {out}: {exc}")
print("Wrote " + ", ".join(written))
print("Analytical transmon simulation:")
print(f"target_f01_GHz={target_f01/1e9:.6f}")
print(f"EC_over_h_GHz={EC_over_h/1e9:.6f}")
print(f"EJ_over_h_GHz={EJ_over_h/1e9:.6f}")
print(f"EJ_over_EC={EJ_EC:.6f}")
print(f"C_total_fF={C_total*1e15:.6f}")
print(f"Ic_nA={Ic*1e9:.6f}")
print(f"anharmonicity_MHz={anharm/1e6:.6f}")
