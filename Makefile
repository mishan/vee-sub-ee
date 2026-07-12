# Vₑ — build convenience wrapper around the node/shell tools.
# `make` builds the browser game (flight.html). See CLAUDE.md for the
# underlying commands; this just wires them together with dependencies.
#
# The original data file and generated assets are gitignored copyrighted
# Ambrosia content (see "Data hygiene" in CLAUDE.md); the paths below point
# at a local copy and can be overridden, e.g. `make DATA=/path/to/EV\ Data.rsrc`.

# DATA is decoded on every build; its name has a space, so it is quoted in
# recipes and never used as a prerequisite. RAW is the asset-conversion source
# dir, ASSETS the converted PNG/WAV + sprite manifest output dir.
DATA    ?= EV_data/EV Data.rsrc
APP     ?= EV_data/EV_1.0.5/Escape Velocity.rsrc
RAW     ?= EV_data
ASSETS  ?= evassets
SCHEMAS := $(wildcard schemas/*.json)
ESBUILD ?= node_modules/.bin/esbuild   # from `npm install` (devDependency)

# Sources that, when changed, should trigger a flight.html rebuild. The data
# file itself is intentionally not a prerequisite: it rarely changes and its
# name contains a space (which make treats as a prerequisite separator), so
# it's referenced only inside the recipes. Run `make clean flight` to force.
FLIGHT_DEPS := flight_template.html engine/core.bundle.js engine/shell.bundle.js \
               evexport.js evrsrc.js semantics.js $(ASSETS)/manifest.json $(SCHEMAS)
GALAXY_DEPS := galaxy_viewer.html evexport.js evrsrc.js semantics.js $(SCHEMAS)

.DEFAULT_GOAL := flight.html

## flight.html   – build the browser game (default)
# --app supplies the EV application rsrc for name suggestions (STR# 128);
# evexport ignores it gracefully if the file is absent.
flight.html: $(FLIGHT_DEPS)
	node evexport.js "$(DATA)" --app "$(APP)" --flight $@

## engine/core.bundle.js – esbuild the ES-module flight core into an IIFE global
# (EV). Generated (gitignored); the loader/evexport inject it.
engine/core.bundle.js: engine/core.js package.json
	$(ESBUILD) $< --bundle --format=iife --global-name=EV \
	  --banner:js='/* GENERATED from engine/core.js by esbuild — do not edit. Rebuild: make engine/core.bundle.js */' \
	  --footer:js='globalThis.EV=EV;' --outfile=$@

## engine/shell.bundle.js – esbuild the ES-module flight shell (engine/shell/*.js,
# entry main.js) into one IIFE. Generated (gitignored); injected at /*__SHELL__*/.
engine/shell.bundle.js: $(wildcard engine/shell/*.js engine/shell/ui/*.js) pilot-codec.js package.json
	$(ESBUILD) engine/shell/main.js --bundle --format=iife \
	  --banner:js='/* GENERATED from engine/shell/*.js by esbuild — do not edit. Rebuild: make engine/shell.bundle.js */' \
	  --outfile=$@

## galaxy.html   – build the galaxy map viewer
galaxy.html: $(GALAXY_DEPS)
	node evexport.js "$(DATA)" --map $@

## evdata.json   – export the full semantic game database
evdata.json: evexport.js evrsrc.js semantics.js $(SCHEMAS)
	node evexport.js "$(DATA)" -o $@ --semantic

# Convenient phony aliases
flight: flight.html
galaxy: galaxy.html
data:   evdata.json

## assets        – convert PICT/snd → PNG/WAV and composite sprite sheets
##                 (needs resource_dasm + ImageMagick on PATH; see CLAUDE.md)
assets:
	./evconvert.sh "$(RAW)" "$(ASSETS)"
	./evsprites.sh "$(ASSETS)"

## sprites       – re-composite sprite+mask sheets only
sprites:
	./evsprites.sh "$(ASSETS)"

## schemas       – regenerate record schemas from the TMPL resources (rare)
schemas:
	node tmpl2schema.js "$(DATA)" -o schemas/

## selftest      – resource-fork library sanity check
selftest:
	node evrsrc.js selftest

## verify        – check the loader's in-browser decoders vs the native pipeline
##                 (needs local EV_data/ + evassets/; see loader/README.md)
verify:
	node loader/verify.js

## test          – run the sanity checks
test: selftest

## clean         – remove generated HTML/JSON build outputs
clean:
	rm -f flight.html galaxy.html evdata.json

## help          – list targets
help:
	@echo "Vₑ make targets:"
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/^## /  /'

.PHONY: flight galaxy data assets sprites schemas selftest verify test clean help
