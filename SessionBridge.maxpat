{
	"patcher": {
		"fileversion": 1,
		"appversion": {
			"major": 9,
			"minor": 1,
			"revision": 4,
			"architecture": "x64",
			"modernui": 1
		},
		"classnamespace": "box",
		"rect": [
			80,
			100,
			840,
			420
		],
		"bglocked": 0,
		"openinpresentation": 1,
		"default_fontsize": 12,
		"default_fontface": 0,
		"default_fontname": "Arial",
		"gridonopen": 1,
		"gridsize": [
			15,
			15
		],
		"gridsnaponopen": 1,
		"objectsnaponopen": 1,
		"statusbarvisible": 2,
		"toolbarvisible": 1,
		"lefttoolbarpinned": 0,
		"toptoolbarpinned": 0,
		"righttoolbarpinned": 0,
		"bottomtoolbarpinned": 0,
		"toolbars_unpinned_last_save": 0,
		"tallnewobj": 0,
		"boxanimatetime": 200,
		"enablehscroll": 1,
		"enablevscroll": 1,
		"devicewidth": 244,
		"description": "Exposes the Live Object Model over a local WebSocket, and serves the Session Manager UI.",
		"digest": "Session Bridge",
		"tags": "session manager bridge",
		"style": "",
		"subpatcher_template": "",
		"assistshowspatchername": 0,
		"boxes": [
			{
				"box": {
					"id": "obj-1",
					"maxclass": "live.comment",
					"patching_rect": [
						520,
						40,
						160,
						20
					],
					"text": "SESSION BRIDGE",
					"numinlets": 1,
					"numoutlets": 0,
					"fontsize": 9,
					"presentation": 1,
					"presentation_rect": [
						12,
						12,
						160,
						16
					]
				}
			},
			{
				"box": {
					"id": "obj-2",
					"maxclass": "live.text",
					"patching_rect": [
						520,
						70,
						200,
						34
					],
					"text": "Open Session Manager",
					"numinlets": 1,
					"numoutlets": 1,
					"outlettype": [
						""
					],
					"mode": 0,
					"parameter_enable": 0,
					"fontsize": 11,
					"texton": "Open Session Manager",
					"presentation": 1,
					"presentation_rect": [
						12,
						36,
						220,
						34
					]
				}
			},
			{
				"box": {
					"id": "obj-3",
					"maxclass": "live.comment",
					"patching_rect": [
						520,
						116,
						200,
						20
					],
					"text": "starting…",
					"numinlets": 1,
					"numoutlets": 0,
					"fontsize": 9,
					"varname": "status",
					"presentation": 1,
					"presentation_rect": [
						12,
						78,
						220,
						16
					]
				}
			},
			{
				"box": {
					"id": "obj-4",
					"maxclass": "live.comment",
					"patching_rect": [
						520,
						146,
						200,
						20
					],
					"text": "127.0.0.1:17800",
					"numinlets": 1,
					"numoutlets": 0,
					"fontsize": 9,
					"presentation": 1,
					"presentation_rect": [
						12,
						96,
						220,
						16
					]
				}
			},
			{
				"box": {
					"id": "obj-5",
					"maxclass": "comment",
					"patching_rect": [
						20,
						14,
						420,
						20
					],
					"text": "Session Bridge — Live Object Model over WebSocket",
					"numinlets": 1,
					"numoutlets": 0,
					"fontsize": 13,
					"fontface": 1
				}
			},
			{
				"box": {
					"id": "obj-6",
					"maxclass": "newobj",
					"patching_rect": [
						20,
						58,
						110,
						22
					],
					"text": "live.thisdevice",
					"numinlets": 1,
					"numoutlets": 3,
					"outlettype": [
						"",
						"",
						""
					]
				}
			},
			{
				"box": {
					"id": "obj-7",
					"maxclass": "message",
					"patching_rect": [
						20,
						90,
						40,
						22
					],
					"text": "init",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					]
				}
			},
			{
				"box": {
					"id": "obj-8",
					"maxclass": "newobj",
					"patching_rect": [
						20,
						130,
						130,
						22
					],
					"text": "r ---bsv-to-node",
					"numinlets": 0,
					"numoutlets": 1,
					"outlettype": [
						""
					]
				}
			},
			{
				"box": {
					"id": "obj-9",
					"maxclass": "newobj",
					"patching_rect": [
						20,
						164,
						300,
						22
					],
					"text": "node.script bridge.js @autostart 1 @watch 1",
					"numinlets": 1,
					"numoutlets": 2,
					"outlettype": [
						"",
						""
					]
				}
			},
			{
				"box": {
					"id": "obj-10",
					"maxclass": "newobj",
					"patching_rect": [
						20,
						202,
						120,
						22
					],
					"text": "s ---bsv-to-lom",
					"numinlets": 1,
					"numoutlets": 0,
					"outlettype": []
				}
			},
			{
				"box": {
					"id": "obj-11",
					"maxclass": "newobj",
					"patching_rect": [
						370,
						58,
						120,
						22
					],
					"text": "r ---bsv-to-lom",
					"numinlets": 0,
					"numoutlets": 1,
					"outlettype": [
						""
					]
				}
			},
			{
				"box": {
					"id": "obj-12",
					"maxclass": "newobj",
					"patching_rect": [
						370,
						90,
						110,
						22
					],
					"text": "route serving",
					"numinlets": 1,
					"numoutlets": 2,
					"outlettype": [
						"",
						""
					]
				}
			},
			{
				"box": {
					"id": "obj-13",
					"maxclass": "newobj",
					"patching_rect": [
						440,
						124,
						70,
						22
					],
					"text": "deferlow",
					"numinlets": 1,
					"numoutlets": 1,
					"outlettype": [
						""
					]
				}
			},
			{
				"box": {
					"id": "obj-14",
					"maxclass": "newobj",
					"patching_rect": [
						440,
						156,
						100,
						22
					],
					"text": "v8 lom.js",
					"numinlets": 1,
					"numoutlets": 1,
					"outlettype": [
						""
					]
				}
			},
			{
				"box": {
					"id": "obj-15",
					"maxclass": "newobj",
					"patching_rect": [
						440,
						190,
						130,
						22
					],
					"text": "s ---bsv-to-node",
					"numinlets": 1,
					"numoutlets": 0,
					"outlettype": []
				}
			},
			{
				"box": {
					"id": "obj-16",
					"maxclass": "newobj",
					"patching_rect": [
						180,
						130,
						100,
						22
					],
					"text": "route ready",
					"numinlets": 1,
					"numoutlets": 2,
					"outlettype": [
						"",
						""
					]
				}
			},
			{
				"box": {
					"id": "obj-17",
					"maxclass": "message",
					"patching_rect": [
						370,
						124,
						120,
						22
					],
					"text": "set \"server up\"",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					]
				}
			},
			{
				"box": {
					"id": "obj-18",
					"maxclass": "message",
					"patching_rect": [
						180,
						164,
						160,
						22
					],
					"text": "set \"connected to Live\"",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					]
				}
			},
			{
				"box": {
					"id": "obj-19",
					"maxclass": "newobj",
					"patching_rect": [
						520,
						200,
						50,
						22
					],
					"text": "sel 1",
					"numinlets": 2,
					"numoutlets": 2,
					"outlettype": [
						"",
						""
					]
				}
			},
			{
				"box": {
					"id": "obj-20",
					"maxclass": "message",
					"patching_rect": [
						520,
						232,
						260,
						22
					],
					"text": "; max launchbrowser http://127.0.0.1:17800",
					"numinlets": 2,
					"numoutlets": 1,
					"outlettype": [
						""
					]
				}
			},
			{
				"box": {
					"id": "obj-21",
					"maxclass": "comment",
					"patching_rect": [
						370,
						38,
						140,
						20
					],
					"text": "LOM side (v8)",
					"numinlets": 1,
					"numoutlets": 0,
					"fontsize": 10
				}
			},
			{
				"box": {
					"id": "obj-22",
					"maxclass": "comment",
					"patching_rect": [
						20,
						110,
						160,
						20
					],
					"text": "server side (node)",
					"numinlets": 1,
					"numoutlets": 0,
					"fontsize": 10
				}
			},
			{
				"box": {
					"id": "obj-23",
					"maxclass": "newobj",
					"patching_rect": [
						20,
						300,
						62,
						22
					],
					"text": "plugin~",
					"numinlets": 2,
					"numoutlets": 2,
					"outlettype": [
						"signal",
						"signal"
					]
				}
			},
			{
				"box": {
					"id": "obj-24",
					"maxclass": "newobj",
					"patching_rect": [
						20,
						334,
						68,
						22
					],
					"text": "plugout~",
					"numinlets": 2,
					"numoutlets": 2,
					"outlettype": [
						"signal",
						"signal"
					]
				}
			},
			{
				"box": {
					"id": "obj-25",
					"maxclass": "comment",
					"patching_rect": [
						96,
						316,
						340,
						20
					],
					"text": "audio passthrough — device is inert on the signal path",
					"numinlets": 1,
					"numoutlets": 0,
					"fontsize": 10
				}
			}
		],
		"lines": [
			{
				"patchline": {
					"destination": [
						"obj-7",
						0
					],
					"source": [
						"obj-6",
						0
					]
				}
			},
			{
				"patchline": {
					"destination": [
						"obj-10",
						0
					],
					"source": [
						"obj-7",
						0
					]
				}
			},
			{
				"patchline": {
					"destination": [
						"obj-10",
						0
					],
					"source": [
						"obj-9",
						0
					]
				}
			},
			{
				"patchline": {
					"destination": [
						"obj-9",
						0
					],
					"source": [
						"obj-8",
						0
					]
				}
			},
			{
				"patchline": {
					"destination": [
						"obj-12",
						0
					],
					"source": [
						"obj-11",
						0
					]
				}
			},
			{
				"patchline": {
					"destination": [
						"obj-17",
						0
					],
					"source": [
						"obj-12",
						0
					]
				}
			},
			{
				"patchline": {
					"destination": [
						"obj-13",
						0
					],
					"source": [
						"obj-12",
						1
					]
				}
			},
			{
				"patchline": {
					"destination": [
						"obj-3",
						0
					],
					"source": [
						"obj-17",
						0
					]
				}
			},
			{
				"patchline": {
					"destination": [
						"obj-14",
						0
					],
					"source": [
						"obj-13",
						0
					]
				}
			},
			{
				"patchline": {
					"destination": [
						"obj-15",
						0
					],
					"source": [
						"obj-14",
						0
					]
				}
			},
			{
				"patchline": {
					"destination": [
						"obj-16",
						0
					],
					"source": [
						"obj-8",
						0
					]
				}
			},
			{
				"patchline": {
					"destination": [
						"obj-18",
						0
					],
					"source": [
						"obj-16",
						0
					]
				}
			},
			{
				"patchline": {
					"destination": [
						"obj-3",
						0
					],
					"source": [
						"obj-18",
						0
					]
				}
			},
			{
				"patchline": {
					"destination": [
						"obj-19",
						0
					],
					"source": [
						"obj-2",
						0
					]
				}
			},
			{
				"patchline": {
					"destination": [
						"obj-20",
						0
					],
					"source": [
						"obj-19",
						0
					]
				}
			},
			{
				"patchline": {
					"destination": [
						"obj-24",
						0
					],
					"source": [
						"obj-23",
						0
					]
				}
			},
			{
				"patchline": {
					"destination": [
						"obj-24",
						1
					],
					"source": [
						"obj-23",
						1
					]
				}
			}
		],
		"dependency_cache": [],
		"autosave": 0
	}
}