# single_xmon_concept_klayout.py
# Conceptual superconducting single-Xmon/transmon chip layout generator for KLayout.
#
# WARNING:
#   This script is for concept/layout discussion only. It is NOT fabrication-ready.
#   You must adapt it to your PDK, layer map, junction process, design rules,
#   EM simulation results, packaging constraints, and foundry requirements.
#
# Usage in KLayout:
#   klayout -b -r single_xmon_concept_klayout.py
# or run from KLayout's macro IDE.
#
# Output:
#   single_xmon_concept.gds

import pya

# -----------------------------
# Utility functions
# -----------------------------

DBU_UM = 0.001  # 1 database unit = 0.001 um = 1 nm


def u(x_um):
    """Convert microns to integer database units."""
    return int(round(x_um / DBU_UM))


def box_um(x1, y1, x2, y2):
    return pya.Box(u(x1), u(y1), u(x2), u(y2))


def path_um(points, width_um):
    pts = [pya.Point(u(x), u(y)) for x, y in points]
    return pya.Path(pts, u(width_um))


def text_um(text, x, y, size_um=40):
    t = pya.Text(text, pya.Trans(u(x), u(y)))
    t.size = u(size_um)
    return t


def add_box(cell, layer, x1, y1, x2, y2):
    cell.shapes(layer).insert(box_um(x1, y1, x2, y2))


def add_path(cell, layer, points, width):
    cell.shapes(layer).insert(path_um(points, width))


def add_label(cell, layer, label, x, y, size=40):
    cell.shapes(layer).insert(text_um(label, x, y, size))


# -----------------------------
# Layout parameters, all in um
# -----------------------------

chip_size = 5000
half_chip = chip_size / 2
margin = 200

# CPW parameters. These are illustrative only.
cpw_w = 10      # center conductor width
cpw_gap = 6     # gap to ground
cpw_keepout = cpw_w / 2 + cpw_gap
pad_size = 180
pad_taper_len = 250

# Qubit/Xmon parameters
qubit_cx = 0
qubit_cy = -300
xmon_arm_len = 320
xmon_arm_w = 32
xmon_gap_to_ground = 24
jj_stub_len = 60
jj_stub_w = 4

# Resonator parameters
res_y = 330
res_x0 = -900
res_x1 = 900
res_pitch = 90
res_meander_amp = 260
res_width = cpw_w
res_segments = 10
res_to_qubit_gap = 24
feed_y = 900
feed_x0 = -2300
feed_x1 = 2300

# Drive line parameters
drive_y = -1000
drive_x0 = -2300
drive_end_x = -380
drive_end_y = -300

# Airbridge conceptual markers
airbridge_w = 28
airbridge_l = 70
airbridge_spacing = 300

# -----------------------------
# Create layout
# -----------------------------

layout = pya.Layout()
layout.dbu = DBU_UM
cell = layout.create_cell("SINGLE_XMON_CONCEPT")

# Layer map. Adapt to real PDK.
L_BOUNDARY = layout.layer(0, 0)       # chip outline / annotation
L_METAL = layout.layer(1, 0)          # main metal positive shapes
L_GAP = layout.layer(2, 0)            # CPW etched gaps / keepout visualization
L_JJ = layout.layer(3, 0)             # conceptual junction marker
L_AIRBRIDGE = layout.layer(4, 0)      # conceptual airbridge marker
L_LABEL = layout.layer(10, 0)         # labels

# -----------------------------
# Chip boundary and ground plane
# -----------------------------

add_box(cell, L_BOUNDARY, -half_chip, -half_chip, half_chip, half_chip)
add_box(cell, L_METAL, -half_chip + margin, -half_chip + margin,
        half_chip - margin, half_chip - margin)

# Note: In a true subtractive CPW mask, you would boolean-subtract gaps from ground.
# Here we draw the gap/keepout on a separate visualization layer so the concept is clear.

# -----------------------------
# Feedline: horizontal CPW across upper chip
# -----------------------------

# Signal conductor
add_path(cell, L_METAL, [(feed_x0, feed_y), (feed_x1, feed_y)], cpw_w)
# Gap visualization around feedline
add_path(cell, L_GAP, [(feed_x0, feed_y), (feed_x1, feed_y)], cpw_w + 2 * cpw_gap)
# Edge pads
add_box(cell, L_METAL, -half_chip + margin, feed_y - pad_size / 2,
        -half_chip + margin + pad_size, feed_y + pad_size / 2)
add_box(cell, L_METAL, half_chip - margin - pad_size, feed_y - pad_size / 2,
        half_chip - margin, feed_y + pad_size / 2)

# -----------------------------
# Meandered lambda/4 readout resonator
# -----------------------------

# Meander path, capacitively near feedline at top and near qubit below.
pts = []
x = res_x0
for i in range(res_segments + 1):
    y = res_y + (res_meander_amp if i % 2 == 0 else -res_meander_amp)
    pts.append((x, y))
    if i < res_segments:
        x += (res_x1 - res_x0) / res_segments
        pts.append((x, y))
# Coupling tail toward qubit
pts.append((250, res_y - res_meander_amp))
pts.append((250, qubit_cy + xmon_arm_len / 2 + res_to_qubit_gap))

add_path(cell, L_METAL, pts, res_width)
add_path(cell, L_GAP, pts, res_width + 2 * cpw_gap)
add_label(cell, L_LABEL, "meander readout resonator, length requires EM tuning", -900, 40, 35)

# Small coupling capacitor marker to feedline
add_box(cell, L_GAP, -120, feed_y - 80, 120, feed_y - 30)
add_label(cell, L_LABEL, "feedline-resonator Cc", -320, feed_y - 160, 30)

# -----------------------------
# Xmon / transmon cross capacitor
# -----------------------------

# Xmon arms as positive metal island. In practice this island must be isolated
# from the surrounding ground by etched gaps and connected to JJ geometry.
add_box(cell, L_METAL,
        qubit_cx - xmon_arm_w / 2, qubit_cy - xmon_arm_len / 2,
        qubit_cx + xmon_arm_w / 2, qubit_cy + xmon_arm_len / 2)
add_box(cell, L_METAL,
        qubit_cx - xmon_arm_len / 2, qubit_cy - xmon_arm_w / 2,
        qubit_cx + xmon_arm_len / 2, qubit_cy + xmon_arm_w / 2)

# Isolation gap visualization around Xmon
add_box(cell, L_GAP,
        qubit_cx - xmon_arm_w / 2 - xmon_gap_to_ground,
        qubit_cy - xmon_arm_len / 2 - xmon_gap_to_ground,
        qubit_cx + xmon_arm_w / 2 + xmon_gap_to_ground,
        qubit_cy + xmon_arm_len / 2 + xmon_gap_to_ground)
add_box(cell, L_GAP,
        qubit_cx - xmon_arm_len / 2 - xmon_gap_to_ground,
        qubit_cy - xmon_arm_w / 2 - xmon_gap_to_ground,
        qubit_cx + xmon_arm_len / 2 + xmon_gap_to_ground,
        qubit_cy + xmon_arm_w / 2 + xmon_gap_to_ground)

# Conceptual JJ stub to ground below the Xmon
add_box(cell, L_METAL,
        qubit_cx - jj_stub_w / 2, qubit_cy - xmon_arm_len / 2 - jj_stub_len,
        qubit_cx + jj_stub_w / 2, qubit_cy - xmon_arm_len / 2)
add_box(cell, L_JJ,
        qubit_cx - 8, qubit_cy - xmon_arm_len / 2 - 18,
        qubit_cx + 8, qubit_cy - xmon_arm_len / 2 - 2)
add_label(cell, L_LABEL, "conceptual JJ region - replace with process-specific cell", 100, qubit_cy - 260, 30)
add_label(cell, L_LABEL, "Xmon / transmon capacitor", -250, qubit_cy - 20, 35)

# -----------------------------
# Drive line and drive pad
# -----------------------------

# Route from left edge to near left Xmon arm.
drive_pts = [
    (drive_x0, drive_y),
    (-1200, drive_y),
    (-800, -700),
    (drive_end_x, drive_end_y),
    (qubit_cx - xmon_arm_len / 2 - 40, qubit_cy),
]
add_path(cell, L_METAL, drive_pts, cpw_w)
add_path(cell, L_GAP, drive_pts, cpw_w + 2 * cpw_gap)
add_box(cell, L_METAL, -half_chip + margin, drive_y - pad_size / 2,
        -half_chip + margin + pad_size, drive_y + pad_size / 2)
add_label(cell, L_LABEL, "drive line, weak capacitive coupling", -1600, drive_y + 80, 30)

# -----------------------------
# Ground bond pads / conceptual ground straps
# -----------------------------

# Ground wirebond pads along edges, represented as metal squares connected to ground plane.
for xpad in [-1800, -1200, -600, 600, 1200, 1800]:
    add_box(cell, L_METAL, xpad - 60, half_chip - margin - 120,
            xpad + 60, half_chip - margin)
    add_box(cell, L_METAL, xpad - 60, -half_chip + margin,
            xpad + 60, -half_chip + margin + 120)

for ypad in [-1800, -1200, -600, 0, 600, 1200, 1800]:
    add_box(cell, L_METAL, -half_chip + margin, ypad - 60,
            -half_chip + margin + 120, ypad + 60)
    add_box(cell, L_METAL, half_chip - margin - 120, ypad - 60,
            half_chip - margin, ypad + 60)

# Airbridge conceptual markers over long CPW lines.
for xab in range(int(feed_x0 + 400), int(feed_x1 - 400), int(airbridge_spacing)):
    add_box(cell, L_AIRBRIDGE, xab - airbridge_l / 2, feed_y - airbridge_w / 2,
            xab + airbridge_l / 2, feed_y + airbridge_w / 2)

# Labels
add_label(cell, L_LABEL, "single Xmon concept layout - not fabrication ready", -2200, 2200, 45)
add_label(cell, L_LABEL, "chip 5 mm x 5 mm", -2200, 2100, 35)
add_label(cell, L_LABEL, "L1 metal, L2 gap visual, L3 JJ marker, L4 airbridge marker", -2200, 2000, 30)

# -----------------------------
# Write GDS
# -----------------------------

layout.write("single_xmon_concept.gds")
print("Wrote single_xmon_concept.gds")
