# Methods and limits: Step 1, Screen sites

Step 1 narrows a study area's streams to a short list of candidate sites for floodplain reconnection.
It works at screening level: it reads values precomputed for every stream, and nothing is measured or
modeled for the site itself. A finer screen (such as FluvialGeomorph) and a field visit confirm what it
finds.

## The data

**The national cross-section grid.** Built for the Stream Tiered Assessment Framework (STAF) and
published as STAF's `staf-xs-current` release, the grid places a cross-section every 100 ft (30.48 m)
along NHDPlus High Resolution stream and canal lines and samples USGS 3DEP elevation across it (1 m
lidar where it exists, else 3 m or 10 m). For each section it records the bankfull depth and width, the
flood-prone width, the low-bank height, the bank height ratio and the entrenchment ratio, with flags for
how each was found.

- **Bankfull** depth and width come from the regional curves of Bieger and others (2015) at the
  section's drainage area: the bankfull stage is set so the channel's area below it matches the
  regional bankfull area.
- **Bank height ratio (BHR)** is the low-bank height above the bed divided by the bankfull depth. The
  low bank is the first break in slope onto a flat. Where none is found below twice the bankfull depth,
  the ratio is capped at 2.00 and reads "at least 2.00".
- **Entrenchment ratio (ER)** is the width of the water at the flood-prone stage (twice the bankfull
  depth) divided by the bankfull width.

**Reaches.** The builder (`data/`) cuts each stream into reaches of about 1,000 ft (10 sections). It
follows the main stem of each stream through NHDPlus HR's flowlines and never crosses a junction where
the drainage area more than doubles, a change between stream and canal, a line the grid does not sample,
or a HUC8 boundary. A chain of N sections becomes `max(1, floor(N/10 + 0.5))` reaches of nearly equal
length. A reach's line follows the stream exactly, cut at the boundaries between its sections.

A reach's values are the medians over its measured sections, as in STAF's screening tool (EASI): BHR and
ER (with their lowest and highest values), bankfull depth and width, flood-prone width and low-bank
height.

## Quality

Each reach carries one of three tiers, with its reasons:

| Tier | When |
|---|---|
| Not enough data | Fewer than 3 sections measured; no elevation data; a median ratio outside its physical range (BHR at or below 0, ER below 1); or a median BHR at the cap only because the channel is too shallow for the elevation data to show a bank below it |
| Use with caution | Bankfull extrapolated outside the regional curve's range on most sections; every bank found by the highest ground rather than a slope break; only 3 or 4 sections measured; the median ER section's flood-prone width runs off the sampled line; or a 3 m or 10 m elevation model |
| No flags | Otherwise |

The tiers soften the rules of STAF's quality record (K2b) and of the pre-registered field comparison
below, which withhold a value in all of these cases. Used as they are, those rules would leave out a
large share of small streams, where bankfull is often extrapolated.

## The screen

The team sets the criteria; the starting values are placeholders for the project team to set in
Task 2. Each criterion filters the reaches the one before it passed:

1. Reaches in the study area (sampled lines only).
2. Not canals or ditches (optional).
3. Measured: no flags, or also "use with caution" (optional).
4. Drainage area within a range.
5. BHR at or above a minimum, counting or leaving out the reaches that read "at least 2.00".
6. ER at or above a minimum.

**Candidate sites.** Along each main stem, upstream to downstream, reaches that pass every criterion make
a site. A site may bridge up to a set number of reaches in a row that fail a criterion or lack data. A
line the grid does not sample, or a reach outside the study area, ends a site. A tributary starts a site
of its own. A site is kept when it is at least the shortest length set. Its values are the medians of
its passing reaches' values.

There is no composite score. The shortlist is ranked by one value the user picks (length by default).

## The field check

At 1,340 EPA National Rivers and Streams Assessment sites in eastern and central regions (pre-registered
before the comparison was run), the grid's raw values tracked field measurements: BHR followed the field
incision ratio (Spearman rho 0.30) and the low-bank height followed the field incision height (rho
0.64). The condition bands STAF's screening tool uses for BHR did not carry over (kappa 0.07), so the
screener shows values, not bands. The entrenchment ratio has no field check yet: NRSA does not measure a
flood-prone width. Condition classes stay off until they pass a field check set in advance.

## Coverage and limits

- The grid is still being built in the western regions. The map's outlines show which HUC8 watersheds
  have reaches, and which are built only in part.
- Wide rivers mapped as artificial paths, lakes and connectors carry no sections. Large leveed rivers
  will be screened from National Levee Database leveed areas and floodplain extent instead.
- In flat coastal plains, much of the bankfull size is extrapolated and lidar over swamps can mislead.
  The values need a field check before any reach is ruled out there.
- In urban watersheds most reaches can read as incised; the ratios then rank less well, and a finer
  screen or field review carries more of the weight.
- One profile per stream line is stored for the cross-section card; other sections are not drawn.

## Planned

- Additional geomorphic metrics from FluvialGeomorph (ERDC) for a finer screen, once the team agrees
  which (candidates: slope and sinuosity, width to depth ratio, stream power, shear stress, planform,
  flood-prone extent from a relative elevation model, floodplain volume).
- Constraint layers: levees, roads, land cover, dams.
- Steps 2 to 4 of the decision tool.

## Reference

Bieger, K., Rathjens, H., Allen, P. M., and Arnold, J. G. (2015). Development and evaluation of bankfull
hydraulic geometry relationships for the physiographic regions of the United States. Journal of the
American Water Resources Association, 51(3), 842 to 858.
