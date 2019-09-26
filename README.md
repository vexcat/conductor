# tabicat
Tabicat helps you visualize what your robot is thinking.

To do this, it asks the robot for a list of registered "experiments", or pre-programmed test routines with various
input parameters. You can create windows to edit the parameters of an experiment and run it, presenting you with the output,
currently just in the form of graphs and text.

You can also animate any registered experiment, automatically re-running it with a parameter being tweaked within a given [start, end] range.

To make your PROS project tabu-capable, ready to use with this tool, then do the following:
  - Grab the C++ implementation of tabu (tabu.cpp/tabu.hpp) from vexcat/strelizia. This is also dependent on having json.hpp from nlohmann's JSON for Modern C++, so make sure you have that in your "include" folder.
  - Add experiments! Code below borrowed from strlizia/src/pidtest.cpp. Note that here, we are returning a number, but you can return any JSON object (number, string, array, and of course objects).
```
  tabu_reply_on("pid_test", [&](const Message& msg) -> json {
    //Code for actually doing PID testing omitted
    for(auto& entry: collectedData) {
      jarr.push_back({
        {"time", entry.time},
        {"error", entry.error},
        {"p", entry.p},
        {"i", entry.i},
        {"d", entry.d},
        {"step", entry.step}
      });
    }
    return {
      {"graphable", jarr}
    };
  });
```
  - Build the UI of your experiment. This consists of listing all the input parameters, and setting a replyaction
```
  tabu_help("pid_test", {
    tlabel("Do a PID test"),
    tnum("kP"), tnum("kI"), tnum("kD"), tnum("kBias"),
    tnum("ms"),
    tbool("useVoltage"),
    tbool("turn"),
    tnum("revs"),
    treplyaction("graph(it.graphable)")
  });
```
  - Notes on treplyaction:
    - The function graph() will graph an object, by default using "time" as the x axis unless you specify in the second parameter.
    - The function say() will print out text
  - Plug your robot in, and run tabicat. Specify the correct COM ports for your device, or the correct /dev/ttyACM files if you're on linux. Then click connect!
  - The experiment should show up on the left column under "Registry", click it to run your code!
