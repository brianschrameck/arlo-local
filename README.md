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

### Download and Run the Arlo Cam API

#### API Configuration

First, create a `config.yaml` file that will be used to configure the server.

```
WifiCountryCode: "US"
MotionRecordingTimeout: 120
AudioRecordingTimeout: 10
RecordAndNotifyOnMotionAlert: false
OnlyNotifyOnMotionAlert: true
RecordOnAudioAlert: false
RecordingBasePath: "/tmp/"
MotionRecordingWebHookUrl: "http://httpbin.org/anything"
AudioRecordingWebHookUrl: "http://httpbin.org/anything"
UserRecordingWebHookUrl: "http://httpbin.org/anything"
StatusUpdateWebHookUrl: "http://httpbin.org/anything"
RegistrationWebHookUrl: "http://httpbin.org/anything"
```

Replace `MotionRecordingWebHookUrl` with the `Motion Sensor Webhook` from the Scrypted plugin configuration.

Replace `StatusUpdateWebHookUrl` with the Status `Update Webhook` from the Scrypted plugin configuration.

#### Using Docker Compose (recommended)

1. Adjust the configuration below to point to your `config.yaml` file.
1. (Optional) Create a file to store the sqlite database used by the server and mount it.

```
version: '3.8'
services:
  arlo-cam-api:
    container_name: 'arlo-cam-api'
    image: 'brianschrameck/arlo-cam-api'        
    ports:
      - 4000:4000
      - 5000:5000
    volumes:
      - ./config.yaml:/opt/arlo-cam-api/config.yaml
      - ./arlo.db:/opt/arlo-cam-api/arlo.db
    restart: 'always'
```

#### Using Docker

Similar guidance as the Docker Compose method as above:

```
docker run \
    --publish-all \
    --volume ./config.yaml:/opt/arlo-cam-api/config.yaml \
    --volume ./arlo.db:/opt/arlo-cam-api/arlo.db brianschrameck/arlo-cam-api
```

#### Manually

Clone the repository and install the necessary dependencies.
```
sudo apt install -y python3-pip
git clone https://github.com/brianschrameck/arlo-cam-api.git
cd arlo-cam-api
pip3 install -r requirements.txt
```

Modify the `config.yaml` file as above, then start the server:

```
python3 server.py
```

How you keep the server running/start it automatically at boot is an exercise left to the reader.

### Networking

The Arlo cameras assume that they will be talking with their Base Station server using port 4000 on *the default gateway* passed from the DHCP server (usually your router). Assuming you are not running the API software on your router, you'll need a way to redirect the camera's requests to your server host.

Below are a few ways to do that:

- Add a static lease to your DCHP server that also sets the default gateway to the host running the server software software (recommended) 
- Create a port forward on port 4000 on the LAN side of your router to redirect traffic to the host running the server software software
- Run the cameras in a different VLAN and configure NAT rules to route traffic to the host running the server software software; this is a tested working scenario:

    Let's say you run a Ubiquiti UniFi network in your home, using a Unifi Security Gateway (a.k.a USG3P). Your cameras reside on VLAN 3 (192.168.3.0/24), while your server running the Arlo Cam API resides on the default untagged LAN at 192.168.1.100. The cameras will try to talk to 192.168.3.1 by default in this configuration. To forward the requests to your server, instead of the default gateway, you could use [Ubiquiti's instructions](https://help.ui.com/hc/en-us/articles/215458888-UniFi-USG-Advanced-Configuration-Using-config-gateway-json) to modify the `config.gateway.json` file to look something like this:

    ```
    {
        "service": {
            "nat": {
                "rule": {
                    "1": {
                    "description": "Redirect Arlo camera traffic to arlo-cam-api",
                    "destination": {
                        "address": "192.168.3.1",
                        "port": "4000"
                    },
                    "inside-address": {
                        "address": "192.168.1.100"
                    },
                    "inbound-interface": "eth1.3",
                    "protocol": "tcp_udp",
                    "type": "destination",
                    "log": "enable"
                    }
                }
            }
        }
    }
    ```

### Capture Real Base Station WPA-PSK

The Arlo Base Station is really just a Wi-Fi router running some custom software and Arlo cameras are paired with the Base Station using Wi-Fi Protected Setup, or WPS. When you press the `SYNC` button on your camera and base station, the two devices authenticate and exchange the information necessary for the camera to connect to the Base Station.

The goal here is to trick the Arlo Base Station into thinking you are a camera so that it gives you the WPA-PSK (i.e. the Wi-Fi password for the base station). To do this, you'll need a Linux machine with a Wi-Fi card. We'll use that machine to connect to the Base Station, but we'll simulate a WPS Pushbutton Configuration (PBC) that will tell the Base Station to give us the WPA-PSK.

*These instructions were run on Ubuntu, but can likely be adapted to your Linux distro.*

1. Install dependencies:

```
apt install wpasupplicant wireless-tools
```

2. Create a `wpa.conf` file with the following information:

```
ctrl_interface=/var/run/wpa_supplicant
ctrl_interface_group=0
update_config=1
device_name=NTGRDEV
manufacturer=broadcom technology, Inc.
```

3. Run these commands, replacing `wlan0` with the interface name of your wireless card (can be obtained by looking at `ifconfig`.) For example, your card may be named `wlo1`. You'll also need the network name of your Arlo Base Station; for example `NETGEAR81`. Be sure to replace the `essid` argument with yours.

```
systemctl stop NetworkManager.service
wpa_supplicant -t -Dwext -i wlan0 -c wpa.conf
iwconfig wlan0 essid NETGEAR81
```

4. Put your Base Station into pairing mode by using the Arlo app or by pressing the `SYNC` button on it, then run this command (again, replacing `wlan0` as necessary):

```
wpa_cli -i wlan0 wps_pbc
```
If all goes well, your `wpa.conf` file should be updated with a section that contains the Wi-Fi network configuration, including the WPA-PSK.

### Set Up A Wi-Fi Network

You can now configure your own Wi-Fi network with that same information (same SSID, using WPA2 with the given PSK). This can be done using a separate wireless access point with a different SSID, or you may be able to broadcast additional SSIDs from your existing router/access point.

You may also have to set the Wi-Fi to the same channel that the Base Station was using for cameras to connect successfully. There are many apps on the market to view wireless networks and their channels around you. Or you can just try switching to each channel for several minutes to see if the cameras connect.

An [alternative, more complex option](https://github.com/brianschrameck/arlo-cam-api#pairing-a-camera-to-your-own-basestation), if you don't want to use a hardware access point is to configure `hostapd` and `dhcpcd` to turn your Linux machine into an access point. You would then need to configure a static route between your main network where you run Scrypted and/or the Arlo Cam API, and the network subnet that the cameras would join. You could also run all of the software (Scrypted, Arlo Cam API, `hostapd`, `dhcpcd`) on a single machine.

After setting up your Wi-Fi network, unplug your Arlo Base Station and give the cameras a few minutes to reconnect. You can tell when things are working when you tail your API server logs and can see registration and status messages for your camera.

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

3. If you have multiple Wi-Fi access points, the cameras tend to hodl on to one. You may want to reboot your camera right next to the access point you want it to connect to. If you have the ability to modify the Minimum RSSI then you can also do that to try and force cameras onto the right access point. Or if you have the ability to lock a camera to an access point in your network software, that can work. However, like mentioned above, you may need to have whatever access points you want the cameras to use to all share the same Wi-Fi channel.

4. If you are getting `ECONNREFUSED` errors in the plugin/camera console, this means your camera is already sending a stream to another socket. This can happen is Scrypted leaves the socket open for some reason. I've had success rebooting the camera in that situation (pulling the battery). You can also try shutting down the Scrypted server for a bit, though I have not found success in this when using Docker. Lastly, you can bump them off the Wi-Fi for a few minutes, at which point they should give up and reset the stream.

5. The live stream can be pretty jittery. Make sure you have VERY strong Wi-Fi coverage for the cameras.

6. You can't control the cameras without using the REST API directly. They are defaulted to always "armed" which means they will always send a motion notification to Scrypted. Video quality is defaulted to "subscription".

7. The camera streams have no authentication mechanism, and they are sent unencrypted over the wire. Use them only on a network you own and trust, as anybody could theoretically listen to the traffic and reconstruct the video by sniffing the packets.