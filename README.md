# openbridge
A bridge between SignalRGB effects and OpenRGB. Comes with some effects!


# Usage

You need node.js and pm2 and openrgb.

Simply run pm2 start --max-memory-restart=200M node bridge.js "path/to/effect.html" <flags>

# Issues
Currently there's a memory leak issue. Help would be appreciated!
