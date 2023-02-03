# Arlo Local Plugin for Scrypted

The Arlo Local Plugin connects Scrypted to your Arlo camera locally, allowing you to access all of your Arlo cameras in Scrypted without relying on their cloud offering in any way. This plugin is in a BETA state and NO WARRANTY IS EXPRESSED OR IMPLIED.

This plugin must be used in conjuction with the [Arlo Cam API](https://github.com/brianschrameck/arlo-cam-api) and has been tested with Arlo Pro 2 cameras and a VMB4000r3 Base Station. It should work for other cameras that are required to connect directly to the Arlo Base Station. It's unclear if it would work for other cameras that can optionally connect to Wi-Fi directly.

## Features Supported

* motion notifications
* battery status (when on battery)
* snapshots (as-requested when plugged in, rate-limited on battery to after motion is detected or after status update is received)
* live video streaming
* live audio support, including muting audio
* Arlo subscription-quality streams without fees or the cloud (higher bitrate and sub-second latency!)
* supports all HomeKit Secure Video (HKSV) features including AI person, vehicle, animal, and package detection, face recognition, etc.; also reports battery status and camera information to HomeKit

## Future Features (maybe)

* audio notifications
* bi-directional audio support/intercom
* sensitivity and volume adjustments
* arm and disarm
* set charged and PIR sensor indicator preferences
* integrate Arlo Cam API into plugin directly (or run as a separate plugin)
* Audio Doorbell support

## Background Context

Arlo does not provide access directly to an RTSP stream, as the cameras are typically connected to the Arlo Base Station. However, through the magic of *reverse engineering*, GitHub user Meatballs1 has [developed some software](https://github.com/Meatballs1/arlo-cam-api) that simulates the base station so that you can control the cameras via a REST API. *That software has been extended and modified for use with this plugin.*

However, that's only one part of the equation. You must also get your cameras onto a Wi-Fi network that you control, which can be very tricky.

Once the cameras are on your Wi-Fi and talking with your simulated base station, this plugin will contact the base station to get information about the cameras and to issue them commands (such as take a snapshot). The plugin will connect to the cameras directly to stream video via RTSP.

## Installation

### Plugin Installation

Install this plugin using the Scrypted interface. Head to the plugin settings to grab the webhook URLs which will be used in the next step.

Do not fill out your server information yet.

### Server and Network Configuration

Follow these steps in the [arlo-cam-api repository](https://github.com/brianschrameck/arlo-cam-api#readme) to configure your network for use with the cameras and create your fake Arlo Base Station.

WARNING: this is tricky and takes some Linux and networking knowledge.

### Plugin Configuration

After you've configured your fake Base Station, set up your network, and connected the cameras to your Wi-Fi, you're ready to hook up the plugin!

Head back to the plugin configuration in Scrypted and put your Arlo Cam API's server information in the `Base Station API Host` field. This should be something like `http://192.168.1.100:5000`. After clicking save, your cameras should be discovered within a couple of seconds.

### Camera Configuration

For each camera discovered by the plugin, head to the `Settings > Streams > Stream: Stream 1` and change the `RTSP Parser` to `Scrypted (UDP)`, then click `Save`.

Congratulations! You finally made it! Your Arlo cameras are ready to use locally.

## Final Steps

If you wish, add the HomeKit plugin and pair your cameras to HomeKit secure video. Or use the rebroadcasted RTSP stream from the Streams menu mentioned above to pipe the camera feed somewhere else. The world is your oyster!

## Troubleshooting and Limitations

Things will break. This is not stable yet. These cameras were never meant to do this and are fickle as hell. Here are some tips:

1. Don't try any of the other parsers as the cameras don't support TCP streams and the FFmpeg parser will cause the stream to crash within seconds, requiring you to reboot your camera.

2. Try not to kill Scrypted processes; let it shut things down gracefully.

3. If you have multiple Wi-Fi access points, the cameras tend to hold on to one. You may want to reboot your camera right next to the access point you want it to connect to. If you have the ability to modify the Minimum RSSI then you can also do that to try and force cameras onto the right access point. Or if you have the ability to lock a camera to an access point in your network software, that can work. However, like mentioned above, you may need to have whatever access points you want the cameras to use to all share the same Wi-Fi channel.

4. If you are getting `ECONNREFUSED` errors in the plugin/camera console, this means your camera is already sending a stream to another socket. This can happen if Scrypted leaves the socket open for some reason. I've had success rebooting the camera in that situation (pulling the battery). You can also try shutting down the Scrypted server for a bit, though I have not found success in this when using Docker. Lastly, you can bump them off the Wi-Fi for a few minutes, at which point they should give up and reset the stream.

5. The live stream can be pretty jittery. Make sure you have VERY strong Wi-Fi coverage for the cameras.

6. You can't control the cameras without using the REST API directly. They are defaulted to always "armed" which means they will always send a motion notification to Scrypted. Video quality is defaulted to "subscription".

7. The camera streams have no authentication mechanism, and they are sent unencrypted over the wire. Use them only on a network you own and trust, as anybody could theoretically listen to the traffic and reconstruct the video by sniffing the packets.