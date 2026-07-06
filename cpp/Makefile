# evflight — C++/SDL2 flight demo. Needs libsdl2-dev; everything else is vendored.
CXX      ?= g++
CXXFLAGS ?= -O2 -std=c++20 -Wall
SDLFLAGS  = $(shell pkg-config --cflags --libs sdl2)

evflight: main.cpp vendor/json.hpp vendor/stb_image.h vendor/stb_image_write.h vendor/font8x8_basic.h
	$(CXX) $(CXXFLAGS) main.cpp -o $@ $(SDLFLAGS)

# Headless render test: 90 logic frames, dump a PNG.
test: evflight
	SDL_VIDEODRIVER=dummy ./evflight --root .. --frames 90 --screenshot test_frame.png

# Golden trace: prove the C++ port matches engine/core.js exactly.
trace: evflight
	node ../engine/check_traces.js

clean:
	rm -f evflight test_frame.png

.PHONY: test clean
