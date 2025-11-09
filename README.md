# Digi-Dx

[![Powered by Kedro](https://img.shields.io/badge/powered_by-kedro-ffc900?logo=kedro)](https://kedro.org)

## Overview

Digi-Dx will eventually be a tool for aiding in contact prioritization for digital amateur radio contests using tools like FT8.
However, right now it is a nearly non-functional prototype.
More to come.

## Design

The main goal of this tool is to interface with WSJT-X. Specific tasks are:

1. Monitor current state of bands
2. Prioritize contacts based on contest-specific scoring parameters
3. Update prioritization based on probability of contact
4. Automatically log contacts from the contest period

The above tasks require serveral components:

1. A WSJT-X monitoring engine
2. A prioritization engine
3. A modeling engine
4. A user interface (UI)

### WSJT-X Monitoring

I believe WSJT-X emit a bespoke message type on a specific port which can be captured to provide state information. This is how GridTracker works.
This is absolutely the long-term goal. But in the near term, I don't have a digital radio with which to run WSJT-X, so I can't test any of that.
So Version 1 of this tool is going to just monitor the ALL.TXT file so when WSJT-X updates that file, the app will also update.
This may not work out well in practice, as I can forsee potential issues related to either A) WSJT-X not updating the file after every messaging cycle, or B) the file updates triggering heavy background operations that make the UI virtually unusable. But we'll cross those bridges when we get there.

### Prioritization Engine

This may be tricky to generalize. But the core idea is that different contests provide different rule sets.
The prioritization engine needs to enable to user to provide a custom rule-set to prioritize contacts by score.
This will ideally be a simple object interface.

### Modeling Engine

The "Probability of contact" engine will be used to dynamically reweight prioritization scores based on _expected_ value, as opposed to real value. In other words, it will down-weight contacts with low probability of contact and up-weight contacts with higher probability of contact.
this codebase will use the Kedro framework. Kedro provides a convenient and well-documented pipeline frameowrk to enable ML models to be coordinated.
Our front-end tool will kick off Kedro jobs in the background, which will then update prioritization files.
These prioritization files will then update in the UI to inform the user of the new predictions.

### User Interface

The UI is going to use Shiny for Python. The reason is that Shiny provides a convenient set of Python-only tools that enable us to make a reactive UI with very little effort. It also integrated beautifully with the Python visualization ecosystem, which will allow this tool to develop into a contest-focused visualization engine.